import { crc32 as zlibCrc32 } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { L2Book } from "../core/orderbook";
import type { AnyEvent, BookDeltaEvent, BookSnapshotEvent, VenueAdapter } from "../core/types";
import { LruSet, backoffDelay, crc32, crc32Signed } from "./base";
import { BinanceAdapter } from "./binance";
import { bitfinexChecksumString, BitfinexAdapter } from "./bitfinex";
import { BybitAdapter } from "./bybit";
import { CoinbaseAdapter } from "./coinbase";
import { DeribitAdapter } from "./deribit";
import { HyperliquidAdapter } from "./hyperliquid";
import { createAdapters, subscribeAll, VENUE_CATALOG } from "./index";
import { krakenChecksum, krakenChecksumString, KrakenAdapter } from "./kraken";
import { KucoinAdapter } from "./kucoin";
import { okxChecksum, okxChecksumString, OkxAdapter } from "./okx";
import { collector, deferred, FakeWS, jsonResponse, routedFetch } from "./testutil";

const wait = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const base = { WebSocketImpl: FakeWS, disablePolling: true, random: () => 0, backoffBaseMs: 2 };

let running: VenueAdapter[] = [];
beforeEach(() => FakeWS.reset());
afterEach(() => {
  for (const a of running) a.stop();
  running = [];
});
function start<T extends VenueAdapter>(a: T, c = collector()) {
  running.push(a);
  a.start(c.emit);
  return { a, c };
}

/** Replays book events into a real L2Book, returning per-delta results. */
function replay(events: AnyEvent[], symbolMarket?: string) {
  const book = new L2Book();
  const results: string[] = [];
  for (const e of events) {
    if (e.kind !== "book_snapshot" && e.kind !== "book_delta") continue;
    if (symbolMarket && e.inst.market !== symbolMarket) continue;
    if (e.kind === "book_snapshot") book.applySnapshot(e as BookSnapshotEvent);
    else results.push(book.applyDelta(e as BookDeltaEvent));
  }
  return { book, results };
}

describe("base infra", () => {
  it("crc32 matches zlib and signed variant wraps", () => {
    for (const s of ["", "hello", "3366.1:7:3366.8:9", "äöü"]) expect(crc32(s)).toBe(zlibCrc32(Buffer.from(s, "utf8")));
    expect(crc32Signed("hello")).toBe(zlibCrc32("hello") | 0);
  });
  it("backoff grows exponentially with jitter and caps", () => {
    expect(backoffDelay(0, 500, () => 0)).toBe(250);
    expect(backoffDelay(3, 500, () => 0.999999)).toBeCloseTo(4000, 0);
    expect(backoffDelay(30, 500, () => 0.999999)).toBeLessThanOrEqual(30_000);
  });
  it("LruSet evicts oldest", () => {
    const s = new LruSet(2);
    expect(s.add("a")).toBe(true);
    expect(s.add("a")).toBe(false);
    s.add("b");
    s.add("c");
    expect(s.add("a")).toBe(true);
  });
});

describe("(a) Binance futures sync algorithm", () => {
  it("drops stale buffered events, applies straddling event, detects pu break and resyncs", async () => {
    let snapId = 100;
    const snapDefer = deferred<void>();
    const { fn, calls } = routedFetch(async (url) => {
      if (url.includes("/fapi/v1/depth")) {
        if (snapId === 100) await snapDefer.promise;
        return jsonResponse({ lastUpdateId: snapId, E: 1, T: 1, bids: [["100", "1"], ["99", "2"]], asks: [["101", "1"], ["102", "3"]] });
      }
      return jsonResponse({ lastUpdateId: 1, bids: [], asks: [] });
    });
    const { a, c } = start(new BinanceAdapter("BTC", { ...base, fetchImpl: fn }));
    const ws = FakeWS.find((w) => w.url.includes("fstream"))!;
    expect(ws.url).toContain("btcusdt@depth@100ms");
    expect(ws.url).toContain("btcusdt@forceOrder");
    ws.open();
    const depth = (U: number, u: number, pu: number, b: [string, string][] = [], a2: [string, string][] = []) =>
      ws.recv({ stream: "btcusdt@depth@100ms", data: { e: "depthUpdate", E: Date.now(), T: Date.now(), s: "BTCUSDT", U, u, pu, b, a: a2 } });
    // Buffered while the snapshot is in flight.
    depth(90, 95, 89, [["100", "9"]]); // u < lastUpdateId → must be dropped
    depth(96, 105, 95, [["100", "5"]]); // straddles 100
    depth(106, 110, 105, [], [["101", "0"]]);
    expect(c.of("book_snapshot")).toHaveLength(0);
    snapDefer.resolve();
    await wait();
    const snaps = c.of("book_snapshot").filter((e) => e.inst.market === "perp");
    expect(snaps).toHaveLength(1);
    expect(snaps[0].seq).toBe(100);
    const deltas = c.of("book_delta").filter((e) => e.inst.market === "perp");
    expect(deltas.map((d) => d.seqLast)).toEqual([105, 110]);
    expect(deltas[1].prevSeq).toBe(105);
    let r = replay(c.events, "perp");
    expect(r.results).toEqual(["applied", "applied"]);
    expect(r.book.bestBid()).toEqual([100, 5]); // the stale "9" was NOT applied
    expect(r.book.bestAsk()).toEqual([102, 3]);
    expect(a.feedState({ symbol: "BTCUSDT", market: "perp" })).toBe("live");

    // pu break → gap → resync from a new snapshot.
    snapId = 200;
    depth(111, 115, 108, [["100", "7"]]);
    expect(c.statuses().some((s) => s.market === "perp" && s.state === "gap_recovering")).toBe(true);
    expect(c.of("book_delta").filter((e) => e.inst.market === "perp")).toHaveLength(2); // broken delta not emitted
    depth(195, 205, 194); // arrives during resync; buffered
    await wait(30);
    expect(calls.filter((u) => u.includes("/fapi/v1/depth")).length).toBe(2);
    const snaps2 = c.of("book_snapshot").filter((e) => e.inst.market === "perp");
    expect(snaps2[1].seq).toBe(200);
    expect(a.feedState({ symbol: "BTCUSDT", market: "perp" })).toBe("live");
    r = replay(c.events, "perp");
    expect(r.book.valid).toBe(true);
  });

  it("spot uses U == last u + 1 continuity", async () => {
    const { fn } = routedFetch(() => jsonResponse({ lastUpdateId: 50, bids: [["10", "1"]], asks: [["11", "1"]] }));
    const { c } = start(new BinanceAdapter("BTC", { ...base, fetchImpl: fn }));
    const ws = FakeWS.find((w) => w.url.includes(":9443"))!;
    ws.open();
    await wait();
    const depth = (U: number, u: number) => ws.recv({ stream: "x", data: { e: "depthUpdate", E: Date.now(), s: "BTCUSDT", U, u, b: [["10", String(u)]], a: [] } });
    depth(45, 50); // u <= lastUpdateId → dropped
    depth(49, 55); // straddles 51
    depth(56, 60);
    const r = replay(c.events, "spot");
    expect(r.results).toEqual(["applied", "applied"]);
    expect(r.book.bestBid()).toEqual([10, 60]);
    depth(62, 64); // gap (61 missing)
    expect(c.statuses().some((s) => s.market === "spot" && s.state === "gap_recovering")).toBe(true);
  });

  it("aggTrade side, forceOrder liquidation side, markPrice funding, duplicate suppression, clock drift", async () => {
    const { fn } = routedFetch((u) => (u.includes("openInterest") ? jsonResponse({ openInterest: "1000", symbol: "BTCUSDT", time: Date.now() }) : jsonResponse({ lastUpdateId: 1, bids: [], asks: [] })));
    const { a, c } = start(new BinanceAdapter("BTC", { ...base, fetchImpl: fn }));
    const ws = FakeWS.find((w) => w.url.includes("fstream"))!;
    ws.open();
    const now = Date.now();
    const agg = { e: "aggTrade", E: now, s: "BTCUSDT", a: 7, p: "60000", q: "0.5", T: now, m: true };
    ws.recv({ data: agg });
    ws.recv({ data: agg }); // duplicate
    ws.recv({ data: { ...agg, a: 8, m: false, T: now - 10_000 } }); // drifted
    const trades = c.of("trade");
    expect(trades).toHaveLength(2);
    expect(trades[0].side).toBe("sell");
    expect(trades[1].side).toBe("buy");
    expect(trades[1].quality).toContain("clock_drift");
    ws.recv({ data: { e: "forceOrder", E: now, o: { s: "BTCUSDT", S: "SELL", q: "0.2", p: "59000", ap: "59010", T: now } } });
    const liq = c.of("liquidation")[0];
    expect(liq.positionSide).toBe("long");
    expect(liq.price).toBe(59010);
    ws.recv({ data: { e: "markPriceUpdate", E: now, s: "BTCUSDT", p: "60010", i: "60000", r: "0.0001", T: now + 3600_000 } });
    expect(c.of("funding")[0].rate).toBe(0.0001);
    expect(c.of("mark_index")[0].mark).toBe(60010);
    await (a as BinanceAdapter)._pollOpenInterest();
    const oi = c.of("open_interest")[0];
    expect(oi.oiBase).toBe(1000);
    expect(oi.oiUsd).toBe(1000 * 60010);
  });

  it("degrades to unavailable when the REST snapshot is blocked", async () => {
    const fn = async () => {
      throw new TypeError("Failed to fetch");
    };
    const { c } = start(new BinanceAdapter("BTC", { ...base, fetchImpl: fn }));
    FakeWS.find((w) => w.url.includes("fstream"))!.open();
    await wait();
    expect(c.statuses().some((s) => s.state === "unavailable" && /Failed to fetch/.test(s.detail ?? ""))).toBe(true);
    expect(c.of("book_snapshot")).toHaveLength(0);
  });
});

describe("(b) Bybit snapshot/delta", () => {
  it("applies snapshot, deltas, drops stale u, resets on u=1", () => {
    const { c } = start(new BybitAdapter("BTC", base));
    const ws = FakeWS.find((w) => w.url.endsWith("/linear"))!;
    ws.open();
    expect(ws.sent[0]).toEqual({ op: "subscribe", args: ["orderbook.200.BTCUSDT", "publicTrade.BTCUSDT", "allLiquidation.BTCUSDT", "tickers.BTCUSDT"] });
    const ob = (type: string, u: number, b: [string, string][], a: [string, string][]) => ws.recv({ topic: "orderbook.200.BTCUSDT", type, ts: Date.now(), data: { s: "BTCUSDT", b, a, u, seq: u * 10 } });
    ob("delta", 5, [["1", "1"]], []); // before snapshot → ignored
    ob("snapshot", 10, [["100", "1"], ["99", "1"]], [["101", "2"]]);
    ob("delta", 11, [["100", "0"]], [["101", "1.5"]]);
    ob("delta", 11, [["98", "5"]], []); // stale duplicate u
    let r = replay(c.events);
    expect(r.results).toEqual(["applied"]);
    expect(r.book.bestBid()).toEqual([99, 1]);
    expect(r.book.bestAsk()).toEqual([101, 1.5]);
    ob("delta", 1, [["50", "1"]], [["51", "1"]]); // service restart → full reset
    r = replay(c.events);
    expect(r.book.bestBid()).toEqual([50, 1]);
    expect(r.book.levelCount).toBe(2);

    ws.recv({ topic: "publicTrade.BTCUSDT", type: "snapshot", ts: Date.now(), data: [{ T: Date.now(), s: "BTCUSDT", S: "Sell", v: "0.3", p: "100", i: "t1" }] });
    expect(c.of("trade")[0].side).toBe("sell");
    ws.recv({ topic: "allLiquidation.BTCUSDT", type: "snapshot", ts: Date.now(), data: [{ T: Date.now(), s: "BTCUSDT", S: "Buy", v: "2", p: "99" }] });
    expect(c.of("liquidation")[0].positionSide).toBe("long");
    ws.recv({ topic: "tickers.BTCUSDT", type: "snapshot", ts: Date.now(), data: { markPrice: "100", indexPrice: "99.9", lastPrice: "100.1", openInterest: "500", openInterestValue: "50000", fundingRate: "0.0002", nextFundingTime: "1700000000000" } });
    ws.recv({ topic: "tickers.BTCUSDT", type: "delta", ts: Date.now(), data: { markPrice: "101" } });
    const mi = c.of("mark_index");
    expect(mi[1].mark).toBe(101);
    expect(mi[1].index).toBe(99.9); // merged from snapshot
    expect(c.of("open_interest")[0].oiUsd).toBe(50000);
    expect(c.of("funding")[0].rate).toBe(0.0002);
  });
});

describe("(c) OKX checksum + sequencing", () => {
  it("checksum string and value follow the documented rule", () => {
    const bids: [string, string][] = [["3366.1", "7"], ["3366", "6"]];
    const asks: [string, string][] = [["3366.8", "9"], ["3368", "8"], ["3372", "8"]];
    expect(okxChecksumString(bids, asks)).toBe("3366.1:7:3366.8:9:3366:6:3368:8:3372:8");
    expect(okxChecksum(bids, asks)).toBe(zlibCrc32("3366.1:7:3366.8:9:3366:6:3368:8:3372:8") | 0);
  });

  it("passes on correct checksum, fails & resubscribes on mismatch, detects prevSeqId breaks, normalizes contracts", async () => {
    const { a, c } = start(new OkxAdapter("BTC", base));
    const ws = FakeWS.instances[0];
    ws.open();
    const bids = [["3366.1", "7", "0", "1"], ["3366", "6", "0", "1"]];
    const asks = [["3366.8", "9", "0", "1"], ["3368", "8", "0", "1"]];
    const ck = okxChecksum(bids.map((r) => [r[0], r[1]] as [string, string]), asks.map((r) => [r[0], r[1]] as [string, string]));
    ws.recv({ arg: { channel: "books", instId: "BTC-USDT-SWAP" }, action: "snapshot", data: [{ bids, asks, ts: String(Date.now()), checksum: ck, prevSeqId: -1, seqId: 10 }] });
    const snap = c.of("book_snapshot")[0];
    expect(snap.inst.market).toBe("perp");
    expect(snap.bids[0]).toEqual([3366.1, 7 * 0.01]); // contracts → BTC
    expect(a.feedState({ symbol: "BTC-USDT-SWAP", market: "perp" })).toBe("live");

    // valid update
    const ck2 = okxChecksum([["3366.1", "7"], ["3366", "6"]], [["3366.8", "4"], ["3368", "8"]]);
    ws.recv({ arg: { channel: "books", instId: "BTC-USDT-SWAP" }, action: "update", data: [{ bids: [], asks: [["3366.8", "4", "0", "1"]], ts: String(Date.now()), checksum: ck2, prevSeqId: 10, seqId: 11 }] });
    expect(replay(c.events).results).toEqual(["applied"]);

    // checksum mismatch → gap + resubscribe
    ws.recv({ arg: { channel: "books", instId: "BTC-USDT-SWAP" }, action: "update", data: [{ bids: [["3366.5", "1", "0", "1"]], asks: [], ts: String(Date.now()), checksum: 12345, prevSeqId: 11, seqId: 12 }] });
    expect(c.statuses().some((s) => s.state === "gap_recovering" && s.detail === "checksum mismatch")).toBe(true);
    expect(c.of("book_delta")).toHaveLength(1);
    await wait(20);
    const ops = ws.sent.filter((m): m is { op: string; args: { channel: string }[] } => typeof m === "object" && m !== null && "op" in m);
    expect(ops.slice(-2).map((o) => o.op)).toEqual(["unsubscribe", "subscribe"]);
    expect(ops.slice(-1)[0].args[0].channel).toBe("books");

    // fresh snapshot then seq break
    ws.recv({ arg: { channel: "books", instId: "BTC-USDT-SWAP" }, action: "snapshot", data: [{ bids, asks, ts: String(Date.now()), checksum: ck, prevSeqId: -1, seqId: 20 }] });
    expect(c.of("book_snapshot")[1].quality).toContain("resynced");
    ws.recv({ arg: { channel: "books", instId: "BTC-USDT-SWAP" }, action: "update", data: [{ bids: [], asks: [], ts: String(Date.now()), prevSeqId: 25, seqId: 26 }] });
    expect(c.statuses().filter((s) => s.state === "gap_recovering")).toHaveLength(2);

    // trades & OI normalization
    ws.recv({ arg: { channel: "trades", instId: "BTC-USDT-SWAP" }, data: [{ instId: "BTC-USDT-SWAP", tradeId: "1", px: "60000", sz: "50", side: "buy", ts: String(Date.now()) }] });
    expect(c.of("trade")[0].size).toBeCloseTo(0.5);
    ws.recv({ arg: { channel: "liquidation-orders", instType: "SWAP" }, data: [{ instId: "BTC-USDT-SWAP", details: [{ side: "sell", posSide: "net", bkPx: "59000", sz: "100", ts: String(Date.now()) }] }, { instId: "ETH-USDT-SWAP", details: [{ side: "buy", posSide: "net", bkPx: "3000", sz: "1", ts: String(Date.now()) }] }] });
    const liqs = c.of("liquidation");
    expect(liqs).toHaveLength(1);
    expect(liqs[0].positionSide).toBe("long");
    expect(liqs[0].size).toBeCloseTo(1);
  });
});

describe("(d) Kraken checksum", () => {
  it("builds the v2 checksum string (strip '.', strip leading zeros, asks then bids)", () => {
    const asks: [string, string][] = [["45285.2", "0.00100000"], ["45286.4", "1.54571953"]];
    const bids: [string, string][] = [["45283.5", "0.10000000"], ["45283.4", "1.54582015"]];
    const s = krakenChecksumString(asks, bids);
    expect(s).toBe("452852" + "100000" + "452864" + "154571953" + "452835" + "10000000" + "452834" + "154582015");
    expect(krakenChecksum(asks, bids)).toBe(zlibCrc32(s));
  });

  it("validates snapshot/update checksums and resubscribes on mismatch", async () => {
    const { c } = start(new KrakenAdapter("BTC", base));
    const ws = FakeWS.instances[0];
    ws.open();
    const bids = [{ price: 45283.5, qty: 0.1 }, { price: 45283.4, qty: 1.54582015 }];
    const asks = [{ price: 45285.2, qty: 0.001 }, { price: 45286.4, qty: 1.54571953 }];
    const ck = krakenChecksum([["45285.2", "0.00100000"], ["45286.4", "1.54571953"]], [["45283.5", "0.10000000"], ["45283.4", "1.54582015"]]);
    ws.recv({ channel: "book", type: "snapshot", data: [{ symbol: "BTC/USD", bids, asks, checksum: ck }] });
    expect(c.of("book_snapshot")).toHaveLength(1);
    const ck2 = krakenChecksum([["45286.4", "1.54571953"]], [["45283.5", "0.10000000"], ["45283.4", "1.54582015"]]);
    ws.recv({ channel: "book", type: "update", data: [{ symbol: "BTC/USD", bids: [], asks: [{ price: 45285.2, qty: 0 }], checksum: ck2, timestamp: new Date().toISOString() }] });
    expect(c.of("book_delta")).toHaveLength(1);
    expect(replay(c.events).book.bestAsk()).toEqual([45286.4, 1.54571953]);
    ws.recv({ channel: "book", type: "update", data: [{ symbol: "BTC/USD", bids: [{ price: 45284, qty: 1 }], asks: [], checksum: 1, timestamp: new Date().toISOString() }] });
    expect(c.statuses().some((s) => s.state === "gap_recovering")).toBe(true);
    expect(c.of("book_delta")).toHaveLength(1);
    await wait(20);
    const methods = ws.sent.map((m) => (m as { method?: string }).method);
    expect(methods.slice(-2)).toEqual(["unsubscribe", "subscribe"]);
  });
});

describe("(e) Deribit change_id chaining", () => {
  it("applies chained changes, converts USD amounts, detects prev_change_id gaps", async () => {
    const { c } = start(new DeribitAdapter("BTC", base));
    const ws = FakeWS.instances[0];
    ws.open();
    const book = (data: unknown) => ws.recv({ jsonrpc: "2.0", method: "subscription", params: { channel: "book.BTC-PERPETUAL.100ms", data } });
    book({ type: "snapshot", timestamp: Date.now(), change_id: 10, bids: [["new", 50000, 100000]], asks: [["new", 50010, 50010]] });
    book({ type: "change", timestamp: Date.now(), prev_change_id: 10, change_id: 11, bids: [["change", 50000, 50000]], asks: [] });
    let r = replay(c.events);
    expect(r.results).toEqual(["applied"]);
    expect(r.book.bestBid()).toEqual([50000, 1]); // 50k USD / 50k = 1 BTC
    expect(r.book.bestAsk()).toEqual([50010, 1]);
    book({ type: "change", timestamp: Date.now(), prev_change_id: 13, change_id: 14, bids: [["delete", 50000, 0]], asks: [] });
    expect(c.statuses().some((s) => s.state === "gap_recovering" && /prev_change_id=13/.test(s.detail ?? ""))).toBe(true);
    expect(c.of("book_delta")).toHaveLength(1);
    await wait(20);
    const methods = ws.sent.map((m) => (m as { method: string }).method);
    expect(methods.slice(-2)).toEqual(["public/unsubscribe", "public/subscribe"]);
    book({ type: "snapshot", timestamp: Date.now(), change_id: 20, bids: [["new", 49990, 49990]], asks: [["new", 50010, 50010]] });
    r = replay(c.events);
    expect(r.book.valid).toBe(true);
    expect(c.of("book_snapshot")[1].quality).toContain("resynced");

    // heartbeat test_request answered
    ws.recv({ jsonrpc: "2.0", method: "heartbeat", params: { type: "test_request" } });
    expect((ws.sent[ws.sent.length - 1] as { method: string }).method).toBe("public/test");

    // trade liquidation flags + ticker
    ws.recv({ jsonrpc: "2.0", method: "subscription", params: { channel: "trades.BTC-PERPETUAL.100ms", data: [{ trade_id: "x1", price: 50000, amount: 25000, direction: "sell", timestamp: Date.now(), liquidation: "T" }] } });
    expect(c.of("trade")[0].size).toBe(0.5);
    expect(c.of("liquidation")[0].positionSide).toBe("long");
    ws.recv({ jsonrpc: "2.0", method: "subscription", params: { channel: "ticker.BTC-PERPETUAL.100ms", data: { timestamp: Date.now(), mark_price: 50000, index_price: 49990, last_price: 50001, open_interest: 1e9, current_funding: 0, funding_8h: 0.0001 } } });
    expect(c.of("open_interest")[0].oiBase).toBe(20000);
  });
});

describe("other venues", () => {
  it("Coinbase: snapshot/update and sequence_num gap forces reconnect", async () => {
    const { c } = start(new CoinbaseAdapter("BTC", base));
    const [book, trades] = FakeWS.instances;
    book.open();
    trades.open();
    const l2 = (seq: number, type: string, updates: unknown[]) => book.recv({ channel: "l2_data", sequence_num: seq, timestamp: new Date().toISOString(), events: [{ type, product_id: "BTC-USD", updates }] });
    l2(0, "snapshot", [{ side: "bid", event_time: "", price_level: "100", new_quantity: "1" }, { side: "offer", event_time: "", price_level: "101", new_quantity: "1" }]);
    l2(1, "update", [{ side: "offer", event_time: "", price_level: "101", new_quantity: "0" }, { side: "offer", event_time: "", price_level: "102", new_quantity: "2" }]);
    expect(replay(c.events).book.bestAsk()).toEqual([102, 2]);
    l2(3, "update", []);
    expect(c.statuses().some((s) => s.state === "gap_recovering")).toBe(true);
    await wait(20);
    expect(FakeWS.instances.length).toBe(3); // reconnected book socket
    trades.recv({ channel: "market_trades", events: [{ type: "update", trades: [{ trade_id: "9", product_id: "BTC-USD", price: "100", size: "0.1", side: "SELL", time: new Date().toISOString() }] }] });
    expect(c.of("trade")[0].side).toBe("sell");
  });

  it("Hyperliquid: full l2Book snapshots, trades side, hourly funding", () => {
    const { c } = start(new HyperliquidAdapter("BTC", base));
    const ws = FakeWS.instances[0];
    ws.open();
    ws.recv({ channel: "l2Book", data: { coin: "BTC", time: Date.now(), levels: [[{ px: "100", sz: "1", n: 1 }], [{ px: "101", sz: "2", n: 1 }]] } });
    ws.recv({ channel: "trades", data: [{ coin: "BTC", side: "B", px: "101", sz: "0.1", time: Date.now(), tid: 1, hash: "h" }] });
    ws.recv({ channel: "activeAssetCtx", data: { coin: "BTC", ctx: { funding: "0.0000125", openInterest: "10", markPx: "100.5", oraclePx: "100.4" } } });
    expect(c.of("book_snapshot")[0].asks[0]).toEqual([101, 2]);
    expect(c.of("trade")[0].side).toBe("buy");
    expect(c.of("funding")[0].intervalHours).toBe(1);
    expect(c.of("open_interest")[0].oiUsd).toBeCloseTo(1005);
  });

  it("Bitfinex: snapshot, updates, checksum pass and fail", () => {
    const { c } = start(new BitfinexAdapter("BTC", base));
    const ws = FakeWS.instances[0];
    ws.open();
    ws.recv({ event: "subscribed", channel: "book", chanId: 5, symbol: "tBTCUSD" });
    ws.recv({ event: "subscribed", channel: "trades", chanId: 6, symbol: "tBTCUSD" });
    ws.recv([5, [[100, 1, 0.5], [99, 2, 1], [101, 1, -0.7]]]);
    ws.recv([5, [99, 0, 1]]);
    const cs = crc32Signed(bitfinexChecksumString([["100", "0.5"]], [["101", "-0.7"]]));
    ws.recv([5, "cs", cs]);
    expect(c.statuses().some((s) => s.state === "gap_recovering")).toBe(false);
    expect(replay(c.events).book.bestBid()).toEqual([100, 0.5]);
    ws.recv([6, "te", [1, Date.now(), -0.25, 100]]);
    expect(c.of("trade")[0]).toMatchObject({ side: "sell", size: 0.25 });
    ws.recv([5, "cs", 42]);
    expect(c.statuses().some((s) => s.state === "gap_recovering")).toBe(true);
  });

  it("KuCoin: token failure degrades to unavailable, never invents data", async () => {
    const fn = async () => {
      throw new TypeError("Failed to fetch");
    };
    const { c } = start(new KucoinAdapter("BTC", { ...base, fetchImpl: fn, autoReconnect: false }));
    await wait();
    const st = c.statuses();
    expect(st.some((s) => s.state === "unavailable" && /bullet-public/.test(s.detail ?? ""))).toBe(true);
    expect(c.events.filter((e) => e.kind !== "feed_status")).toHaveLength(0);
  });

  it("KuCoin: with a token it connects and parses depth50 + matches", async () => {
    const { fn } = routedFetch(() => jsonResponse({ code: "200000", data: { token: "tok", instanceServers: [{ endpoint: "wss://ws-api-spot.kucoin.com/", pingInterval: 18000, protocol: "websocket" }] } }));
    const { c } = start(new KucoinAdapter("BTC", { ...base, fetchImpl: fn }));
    await wait();
    const ws = FakeWS.instances[0];
    expect(ws.url).toContain("token=tok");
    ws.open();
    ws.recv({ type: "message", topic: "/spotMarket/level2Depth50:BTC-USDT", data: { bids: [["100", "1"]], asks: [["101", "1"]], timestamp: Date.now() } });
    ws.recv({ type: "message", topic: "/market/match:BTC-USDT", data: { tradeId: "a", price: "100", size: "1", side: "sell", time: String(Date.now() * 1e6) } });
    expect(c.of("book_snapshot")).toHaveLength(1);
    expect(c.of("trade")[0].quality).toEqual(["ok"]);
  });
});

describe("registry", () => {
  it("creates one adapter per catalog venue and subscribeAll starts/stops them", () => {
    const adapters = createAdapters("ETH", undefined, base);
    expect(adapters.map((a) => a.venue).sort()).toEqual(VENUE_CATALOG.map((v) => v.venue).sort());
    expect(createAdapters("BTC", ["okx", "sim"], base).map((a) => a.venue)).toEqual(["okx"]);
    const c = collector();
    const stop = subscribeAll(adapters, c.emit);
    for (const ws of [...FakeWS.instances]) ws.open();
    expect(c.statuses().length).toBeGreaterThan(0);
    stop();
    const n = c.events.length;
    FakeWS.instances[0].recv({});
    expect(c.events.length).toBe(n);
  });

  it("stale detection flags a silent feed", async () => {
    const { c } = start(new HyperliquidAdapter("BTC", { ...base, staleMs: 40 }));
    FakeWS.instances[0].open();
    await wait(90);
    expect(c.statuses().some((s) => s.state === "stale")).toBe(true);
  });
});

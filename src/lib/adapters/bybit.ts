/**
 * Bybit v5 public streams: spot + USDT linear perpetual.
 *
 * orderbook.200: first message is a snapshot; deltas carry update id `u`. A snapshot can
 * arrive at any time (and `u == 1` signals a service restart) — both reset the local book.
 * `u` must strictly increase; a non-increasing `u` is dropped as stale. Bybit does not
 * publish a prev-id, so the adapter enforces monotonicity and the engine receives deltas
 * with null sequence fields (validated here, not in L2Book).
 */
import type { Asset, InstrumentRef } from "../core/types";
import { BaseAdapter, lvl, num, type AdapterOptions } from "./base";

export const BYBIT_WS = { spot: "wss://stream.bybit.com/v5/public/spot", linear: "wss://stream.bybit.com/v5/public/linear" };

interface Ticker {
  markPrice?: string;
  indexPrice?: string;
  lastPrice?: string;
  openInterest?: string;
  openInterestValue?: string;
  fundingRate?: string;
  nextFundingTime?: string;
  fundingIntervalHour?: string;
}

export class BybitAdapter extends BaseAdapter {
  readonly venue = "bybit" as const;
  readonly instruments: InstrumentRef[];
  readonly spot: InstrumentRef;
  readonly perp: InstrumentRef;
  private lastU = new Map<string, number>();
  private haveSnap = new Map<string, boolean>();
  private ticker: Ticker = {};

  constructor(asset: Asset, opts: AdapterOptions = {}) {
    super(asset, opts);
    const sym = `${asset}USDT`;
    this.spot = { venue: "bybit", symbol: sym, asset, market: "spot", contract: "spot", quote: "USDT", multiplier: 1 };
    this.perp = { venue: "bybit", symbol: sym, asset, market: "perp", contract: "linear", quote: "USDT", multiplier: 1 };
    this.instruments = [this.spot, this.perp];
  }

  protected open() {
    for (const inst of this.instruments) {
      const lin = inst.market === "perp";
      const args = [`orderbook.200.${inst.symbol}`, `publicTrade.${inst.symbol}`];
      if (lin) args.push(`allLiquidation.${inst.symbol}`, `tickers.${inst.symbol}`);
      this.socket({
        url: lin ? BYBIT_WS.linear : BYBIT_WS.spot,
        onOpen: (s) => s.send({ op: "subscribe", args }),
        onMessage: (raw) => this.onMessage(inst, raw),
        onState: (st, d) => this.status(inst, st, d),
        onReset: () => {
          this.haveSnap.set(inst.market, false);
          this.lastU.delete(inst.market);
          if (lin) this.ticker = {};
        },
        ping: { intervalMs: 20_000, payload: () => JSON.stringify({ op: "ping" }) },
      });
    }
  }

  private onMessage(inst: InstrumentRef, raw: string) {
    const m = JSON.parse(raw) as { topic?: string; type?: string; ts?: number; data?: unknown; op?: string; success?: boolean; ret_msg?: string };
    if (!m.topic) {
      if (m.op === "subscribe" && m.success === false) this.status(inst, "unavailable", `subscribe rejected: ${m.ret_msg}`);
      return;
    }
    const lin = inst.market === "perp";
    const src = lin ? "bybit.linear.ws" : "bybit.spot.ws";
    if (m.topic.startsWith("orderbook.")) {
      const d = m.data as { s: string; b: [string, string][]; a: [string, string][]; u: number; seq?: number };
      const k = inst.market;
      if (m.type === "snapshot" || d.u === 1) {
        this.snapshot(inst, lvl(d.b), lvl(d.a), d.u, m.ts ?? null, `${src}.orderbook.snapshot`, this.haveSnap.get(k) ? ["resynced"] : []);
        this.haveSnap.set(k, true);
        this.lastU.set(k, d.u);
        this.status(inst, "live");
        return;
      }
      if (!this.haveSnap.get(k)) return; // delta before snapshot — wait
      const last = this.lastU.get(k)!;
      if (d.u <= last) return; // stale / duplicate
      this.lastU.set(k, d.u);
      this.delta(inst, lvl(d.b), lvl(d.a), null, null, null, m.ts ?? null, `${src}.orderbook.delta`);
    } else if (m.topic.startsWith("publicTrade.")) {
      for (const t of m.data as { T: number; S: "Buy" | "Sell"; v: string; p: string; i: string }[]) {
        // S is the taker (aggressor) side.
        this.trade(inst, t.i, num(t.p), num(t.v), t.S === "Buy" ? "buy" : "sell", t.T, `${src}.publicTrade`);
      }
    } else if (m.topic.startsWith("allLiquidation.")) {
      for (const l of m.data as { T: number; S: "Buy" | "Sell"; v: string; p: string }[]) {
        const price = num(l.p), size = num(l.v);
        if (!(price > 0 && size > 0)) continue;
        // Per Bybit docs S is the POSITION side: "Buy" → a long position was liquidated.
        this.emit({ kind: "liquidation", ...this.meta(inst, l.T, `${src}.allLiquidation`), price, size, positionSide: l.S === "Buy" ? "long" : "short" });
      }
    } else if (m.topic.startsWith("tickers.")) {
      const d = m.data as Ticker;
      if (m.type === "snapshot") this.ticker = { ...d };
      else for (const [k, v] of Object.entries(d)) if (v !== undefined && v !== "") (this.ticker as Record<string, unknown>)[k] = v;
      const t = this.ticker;
      const ts = m.ts ?? null;
      const mark = num(t.markPrice), index = num(t.indexPrice), last = num(t.lastPrice);
      if ("markPrice" in d || "indexPrice" in d || "lastPrice" in d)
        this.emit({ kind: "mark_index", ...this.meta(inst, ts, `${src}.tickers`), mark: fin(mark), index: fin(index), last: fin(last) });
      if ("openInterest" in d || "openInterestValue" in d) {
        const oiBase = num(t.openInterest);
        const oiUsd = num(t.openInterestValue);
        const usd = Number.isFinite(oiUsd) ? oiUsd : oiBase * (fin(mark) ?? NaN);
        if (Number.isFinite(oiBase) && Number.isFinite(usd)) this.emit({ kind: "open_interest", ...this.meta(inst, ts, `${src}.tickers`), oiBase, oiUsd: usd });
      }
      if ("fundingRate" in d || "nextFundingTime" in d) {
        const rate = num(t.fundingRate);
        if (Number.isFinite(rate))
          this.emit({ kind: "funding", ...this.meta(inst, ts, `${src}.tickers`), rate, intervalHours: num(t.fundingIntervalHour) || 8, nextFundingTs: num(t.nextFundingTime) || null });
      }
    }
  }
}

function fin(x: number): number | null {
  return Number.isFinite(x) ? x : null;
}

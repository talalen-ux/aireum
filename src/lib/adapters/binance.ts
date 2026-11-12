/**
 * Binance spot + USDⓈ-M perpetual.
 *
 * Book sync follows Binance's documented "manage a local order book" algorithm:
 *  1. Open the diff stream (@depth@100ms) and BUFFER events.
 *  2. Fetch a REST snapshot (lastUpdateId).
 *  3. Drop buffered events with u < lastUpdateId (spot: u <= lastUpdateId).
 *  4. First applied event must straddle the snapshot:
 *       spot:    U <= lastUpdateId+1 <= u
 *       futures: U <= lastUpdateId   <= u
 *  5. Continuity thereafter — spot: U == prev u + 1;  futures: pu == prev u.
 *  Any break → feed "gap_recovering", discard state, re-snapshot (with backoff).
 */
import type { Asset, InstrumentRef } from "../core/types";
import { BaseAdapter, backoffDelay, lvl, num, type AdapterOptions, type ManagedSocket } from "./base";

interface DepthMsg {
  e: "depthUpdate";
  E: number;
  T?: number;
  s: string;
  U: number;
  u: number;
  pu?: number;
  b: [string, string][];
  a: [string, string][];
}

interface BookSync {
  inst: InstrumentRef;
  state: "buffering" | "snapshotting" | "live";
  buffer: DepthMsg[];
  lastU: number | null; // last applied u
  snapshotId: number | null;
  resyncAttempt: number;
  epoch: number; // invalidates in-flight snapshot fetches after a reset
}

export const BINANCE_SPOT_WS = "wss://stream.binance.com:9443/stream?streams=";
export const BINANCE_FUT_WS = "wss://fstream.binance.com/stream?streams=";
export const BINANCE_SPOT_REST = "https://api.binance.com";
export const BINANCE_FUT_REST = "https://fapi.binance.com";

export class BinanceAdapter extends BaseAdapter {
  readonly venue = "binance" as const;
  readonly instruments: InstrumentRef[];
  readonly spot: InstrumentRef;
  readonly perp: InstrumentRef;
  private syncs = new Map<string, BookSync>();
  private lastMark: number | null = null;
  private lastIndex: number | null = null;
  private lastLast: number | null = null;
  private resyncTimers: ReturnType<typeof setTimeout>[] = [];

  constructor(asset: Asset, opts: AdapterOptions = {}) {
    super(asset, opts);
    const sym = `${asset}USDT`;
    this.spot = { venue: "binance", symbol: sym, asset, market: "spot", contract: "spot", quote: "USDT", multiplier: 1 };
    this.perp = { venue: "binance", symbol: sym, asset, market: "perp", contract: "linear", quote: "USDT", multiplier: 1 };
    this.instruments = [this.spot, this.perp];
  }

  protected open() {
    for (const inst of this.instruments) {
      const fut = inst.market === "perp";
      const s = inst.symbol.toLowerCase();
      const streams = [`${s}@depth@100ms`, `${s}@aggTrade`];
      if (fut) streams.push(`${s}@forceOrder`, `${s}@markPrice@1s`);
      const sync: BookSync = { inst, state: "buffering", buffer: [], lastU: null, snapshotId: null, resyncAttempt: 0, epoch: 0 };
      this.syncs.set(inst.market, sync);
      this.socket({
        url: (fut ? BINANCE_FUT_WS : BINANCE_SPOT_WS) + streams.join("/"),
        onOpen: () => this.beginSync(sync),
        onMessage: (raw) => this.onMessage(inst, sync, raw),
        onState: (st, d) => this.status(inst, st, d),
        onReset: () => this.resetSync(sync),
      });
    }
    this.every(10_000, () => void this.pollOpenInterest());
  }

  protected onStop() {
    for (const t of this.resyncTimers) clearTimeout(t);
    this.resyncTimers = [];
  }

  private resetSync(sync: BookSync) {
    sync.state = "buffering";
    sync.buffer = [];
    sync.lastU = null;
    sync.snapshotId = null;
    sync.epoch++;
  }

  private beginSync(sync: BookSync) {
    this.resetSync(sync);
    void this.fetchSnapshot(sync);
  }

  private async fetchSnapshot(sync: BookSync) {
    const epoch = sync.epoch;
    sync.state = "snapshotting";
    const fut = sync.inst.market === "perp";
    const url = fut
      ? `${BINANCE_FUT_REST}/fapi/v1/depth?symbol=${sync.inst.symbol}&limit=1000`
      : `${BINANCE_SPOT_REST}/api/v3/depth?symbol=${sync.inst.symbol}&limit=1000`;
    const r = await this.getJson<{ lastUpdateId: number; E?: number; T?: number; bids: [string, string][]; asks: [string, string][] }>(url);
    if (!this.running || epoch !== sync.epoch) return;
    if (!r.data) {
      this.status(sync.inst, r.rateLimited ? "stale" : "unavailable", `depth snapshot failed: ${r.error}`);
      this.scheduleResync(sync);
      return;
    }
    const snap = r.data;
    sync.snapshotId = snap.lastUpdateId;
    sync.lastU = null;
    this.snapshot(sync.inst, lvl(snap.bids), lvl(snap.asks), snap.lastUpdateId, snap.E ?? snap.T ?? null, fut ? "binance.fapi.rest.depth" : "binance.api.rest.depth");
    sync.state = "live";
    const buffered = sync.buffer;
    sync.buffer = [];
    for (const m of buffered) {
      if (!this.applyDepth(sync, m)) return;
    }
    if (sync.state === "live") {
      sync.resyncAttempt = 0;
      this.status(sync.inst, "live");
    }
  }

  private scheduleResync(sync: BookSync) {
    if (!this.running) return;
    const d = backoffDelay(sync.resyncAttempt++, this.backoffBaseMs, this.random);
    const epoch = sync.epoch;
    const t = setTimeout(() => {
      if (this.running && epoch === sync.epoch) void this.fetchSnapshot(sync);
    }, d);
    this.resyncTimers.push(t);
  }

  /** Returns false if a gap was detected (sync reset). */
  private applyDepth(sync: BookSync, m: DepthMsg): boolean {
    const fut = sync.inst.market === "perp";
    const id = sync.snapshotId!;
    if (sync.lastU === null) {
      // Drop events fully covered by the snapshot.
      if (fut ? m.u < id : m.u <= id) return true;
      const straddles = fut ? m.U <= id && m.u >= id : m.U <= id + 1 && m.u >= id + 1;
      if (!straddles) return this.gap(sync, `first event U=${m.U} u=${m.u} does not straddle snapshot ${id}`);
      // Normalized for L2Book: range check against snapshot seq.
      this.delta(sync.inst, lvl(m.b), lvl(m.a), Math.min(m.U, id + 1), m.u, null, m.E, fut ? "binance.fapi.ws.depth" : "binance.api.ws.depth");
      sync.lastU = m.u;
      return true;
    }
    if (m.u <= sync.lastU) return true; // stale duplicate
    if (fut) {
      if (m.pu !== sync.lastU) return this.gap(sync, `pu=${m.pu} != last u=${sync.lastU}`);
      this.delta(sync.inst, lvl(m.b), lvl(m.a), m.U, m.u, m.pu, m.E, "binance.fapi.ws.depth");
    } else {
      if (m.U !== sync.lastU + 1) return this.gap(sync, `U=${m.U} != last u+1=${sync.lastU + 1}`);
      this.delta(sync.inst, lvl(m.b), lvl(m.a), m.U, m.u, null, m.E, "binance.api.ws.depth");
    }
    sync.lastU = m.u;
    return true;
  }

  private gap(sync: BookSync, detail: string): false {
    this.status(sync.inst, "gap_recovering", detail);
    this.resetSync(sync);
    this.scheduleResync(sync);
    return false;
  }

  private onMessage(inst: InstrumentRef, sync: BookSync, raw: string) {
    const env = JSON.parse(raw) as { stream?: string; data?: Record<string, unknown> };
    const d = (env.data ?? env) as Record<string, unknown>;
    switch (d.e) {
      case "depthUpdate": {
        const m = d as unknown as DepthMsg;
        if (sync.state !== "live") sync.buffer.push(m);
        else this.applyDepth(sync, m);
        break;
      }
      case "aggTrade": {
        const fut = inst.market === "perp";
        if (fut) this.lastLast = num(d.p);
        // m=true → buyer is maker → aggressor SOLD.
        this.trade(inst, d.a as number, num(d.p), num(d.q), d.m ? "sell" : "buy", (d.T as number) ?? (d.E as number), fut ? "binance.fapi.ws.aggTrade" : "binance.api.ws.aggTrade");
        break;
      }
      case "forceOrder": {
        const o = d.o as Record<string, unknown>;
        const ap = num(o.ap);
        const price = ap > 0 ? ap : num(o.p);
        const size = num(o.q);
        if (price > 0 && size > 0)
          this.emit({
            kind: "liquidation",
            ...this.meta(inst, (o.T as number) ?? (d.E as number), "binance.fapi.ws.forceOrder"),
            price,
            size,
            // A SELL liquidation order closes a LONG.
            positionSide: o.S === "SELL" ? "long" : "short",
          });
        break;
      }
      case "markPriceUpdate": {
        const mark = num(d.p);
        const index = num(d.i);
        this.lastMark = Number.isFinite(mark) ? mark : this.lastMark;
        this.lastIndex = Number.isFinite(index) ? index : this.lastIndex;
        const ts = d.E as number;
        this.emit({ kind: "mark_index", ...this.meta(inst, ts, "binance.fapi.ws.markPrice"), mark: this.lastMark, index: this.lastIndex, last: this.lastLast });
        const rate = num(d.r);
        if (Number.isFinite(rate))
          this.emit({
            kind: "funding",
            ...this.meta(inst, ts, "binance.fapi.ws.markPrice"),
            rate,
            // BTCUSDT/ETHUSDT settle every 8h; some symbols use 4h (see /fapi/v1/fundingInfo).
            intervalHours: 8,
            nextFundingTs: Number(d.T) || null,
          });
        break;
      }
    }
  }

  private async pollOpenInterest() {
    const r = await this.getJson<{ openInterest: string; symbol: string; time: number }>(`${BINANCE_FUT_REST}/fapi/v1/openInterest?symbol=${this.perp.symbol}`);
    if (!r.data) return; // OI simply absent this cycle; never invented.
    const oiBase = num(r.data.openInterest);
    if (!Number.isFinite(oiBase)) return;
    const px = this.lastMark;
    if (px === null) return; // cannot normalize to USD without a mark yet
    this.emit({ kind: "open_interest", ...this.meta(this.perp, r.data.time ?? null, "binance.fapi.rest.openInterest"), oiBase, oiUsd: oiBase * px });
  }

  /** test hook */
  _syncState(market: "spot" | "perp") {
    return this.syncs.get(market);
  }
  _pollOpenInterest() {
    return this.pollOpenInterest();
  }
  _sockets(): ManagedSocket[] {
    return this.sockets;
  }
}

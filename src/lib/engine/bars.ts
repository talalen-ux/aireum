import type { Timeframe } from "../core/types";
import { TF_MS } from "../core/types";

/**
 * OHLCV bar with signed-flow decomposition. Volumes in BASE units.
 * Flow fields are `null` when the source could not attribute aggressor side
 * (e.g. a fallback venue whose klines lack taker-buy volume) — never guessed.
 */
export interface Bar {
  t: number; // open time ms
  o: number;
  h: number;
  l: number;
  c: number;
  /** spot taker buy / sell volume (base) */
  spotBuy: number | null;
  spotSell: number | null;
  /** perp taker buy / sell volume (base) */
  perpBuy: number | null;
  perpSell: number | null;
  /** perp open interest at bar close (base) */
  oi: number | null;
  /** funding rate (per 8h-equivalent fraction) at bar close */
  funding: number | null;
  /** observed liquidations (base) */
  liqLong: number;
  liqShort: number;
  /** perp premium vs spot at close, bps */
  basisBps: number | null;
}

export function emptyBar(t: number, px: number): Bar {
  return { t, o: px, h: px, l: px, c: px, spotBuy: null, spotSell: null, perpBuy: null, perpSell: null, oi: null, funding: null, liqLong: 0, liqShort: 0, basisBps: null };
}

const add = (a: number | null, b: number) => (a === null ? b : a + b);

/** Fixed-capacity bar series for one timeframe. Bars are aligned to UTC epoch multiples. */
export class BarSeries {
  readonly bars: Bar[] = [];
  readonly ms: number;
  constructor(readonly tf: Timeframe | "1m", readonly cap = 1500) {
    this.ms = tf === "1m" ? 60_000 : TF_MS[tf];
  }
  align(ts: number) {
    if (this.tf === "1w") {
      // Binance weekly bars open Monday 00:00 UTC; epoch (Thu) offset = 4 days
      const off = 4 * 86_400_000;
      return Math.floor((ts - off) / this.ms) * this.ms + off;
    }
    return Math.floor(ts / this.ms) * this.ms;
  }
  last(): Bar | undefined {
    return this.bars[this.bars.length - 1];
  }
  /** Get (creating if needed) the bar containing ts, using px to open it. */
  barAt(ts: number, px: number): Bar | null {
    const t = this.align(ts);
    const last = this.last();
    if (last && t < last.t) return null; // late event older than current bar: ignore for bars
    if (last && t === last.t) return last;
    const b = emptyBar(t, last ? last.c : px);
    if (last) {
      b.o = last.c; b.h = Math.max(last.c, px); b.l = Math.min(last.c, px);
      b.oi = last.oi; b.funding = last.funding; b.basisBps = last.basisBps;
    }
    this.bars.push(b);
    if (this.bars.length > this.cap) this.bars.shift();
    return b;
  }
  onPrice(ts: number, px: number) {
    const b = this.barAt(ts, px);
    if (!b) return;
    b.c = px;
    if (px > b.h) b.h = px;
    if (px < b.l) b.l = px;
  }
  onTrade(ts: number, px: number, size: number, side: "buy" | "sell", market: "spot" | "perp") {
    const b = this.barAt(ts, px);
    if (!b) return;
    if (market === "spot") {
      if (side === "buy") b.spotBuy = add(b.spotBuy, size); else b.spotSell = add(b.spotSell, size);
      if (b.spotBuy === null) b.spotBuy = 0;
      if (b.spotSell === null) b.spotSell = 0;
    } else {
      if (side === "buy") b.perpBuy = add(b.perpBuy, size); else b.perpSell = add(b.perpSell, size);
      if (b.perpBuy === null) b.perpBuy = 0;
      if (b.perpSell === null) b.perpSell = 0;
    }
  }
  onLiq(ts: number, px: number, size: number, positionSide: "long" | "short") {
    const b = this.barAt(ts, px);
    if (!b) return;
    if (positionSide === "long") b.liqLong += size; else b.liqShort += size;
  }
  setField(ts: number, px: number, k: "oi" | "funding" | "basisBps", v: number) {
    const b = this.barAt(ts, px);
    if (b) b[k] = v;
  }
  /** Merge a history bar (from REST). Replaces bars with same t; keeps order. */
  mergeHistory(hist: Bar[]) {
    const map = new Map<number, Bar>();
    for (const b of this.bars) map.set(b.t, b);
    for (const h of hist) {
      const cur = map.get(h.t);
      map.set(h.t, cur ? { ...h, liqLong: cur.liqLong + h.liqLong, liqShort: cur.liqShort + h.liqShort } : h);
    }
    const merged = [...map.values()].sort((a, b) => a.t - b.t).slice(-this.cap);
    this.bars.length = 0;
    this.bars.push(...merged);
  }
}

export const spotDelta = (b: Bar) => (b.spotBuy !== null && b.spotSell !== null ? b.spotBuy - b.spotSell : null);
export const perpDelta = (b: Bar) => (b.perpBuy !== null && b.perpSell !== null ? b.perpBuy - b.perpSell : null);
export const totalVol = (b: Bar) => (b.spotBuy ?? 0) + (b.spotSell ?? 0) + (b.perpBuy ?? 0) + (b.perpSell ?? 0);

/** Wilder ATR over the last n bars. */
export function atr(bars: Bar[], n = 14): number | null {
  if (bars.length < n + 1) return null;
  let s = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    s += Math.max(b.h - b.l, Math.abs(b.h - p.c), Math.abs(b.l - p.c));
  }
  return s / n;
}

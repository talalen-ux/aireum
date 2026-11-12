import type { BookDeltaEvent, BookLevel, BookSnapshotEvent } from "./types";

/**
 * Venue-agnostic L2 order book with sequence validation.
 *
 * Sequencing contract (adapters normalize venue semantics into this):
 *  - A snapshot resets the book and sets `seq`.
 *  - A delta is valid if either:
 *      a) `prevSeq` is provided and equals the book's current seq, or
 *      b) `prevSeq` is null, `seqFirst` <= seq + 1 <= `seqLast` (Binance-spot style ranges), or
 *      c) both are null (venue offers no sequencing — checksum or periodic snapshots used instead).
 *  - Deltas entirely older than the book (seqLast <= seq) are ignored (stale buffered updates).
 *  - Anything else is a GAP: the book is marked invalid and must be rebuilt from a fresh snapshot.
 *    No analytics are produced from an invalid book.
 */
export type ApplyResult = "applied" | "ignored_stale" | "gap" | "not_ready";

export class L2Book {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();
  private sortedBids: BookLevel[] | null = null;
  private sortedAsks: BookLevel[] | null = null;
  seq: number | null = null;
  valid = false;
  lastUpdateTs = 0;
  lastExchTs: number | null = null;
  gaps = 0;
  updates = 0;
  /** Cumulative added / removed size near touch, used for replenishment & cancellation metrics. */
  readonly churn = { bidAdd: 0, bidRemove: 0, askAdd: 0, askRemove: 0 };

  applySnapshot(s: BookSnapshotEvent) {
    this.bids.clear();
    this.asks.clear();
    for (const [p, q] of s.bids) if (q > 0) this.bids.set(p, q);
    for (const [p, q] of s.asks) if (q > 0) this.asks.set(p, q);
    this.seq = s.seq;
    this.valid = true;
    this.sortedBids = this.sortedAsks = null;
    this.lastUpdateTs = s.recvTs;
    this.lastExchTs = s.exchTs;
  }

  applyDelta(d: BookDeltaEvent, churnBandBps = 25): ApplyResult {
    if (!this.valid) return "not_ready";
    if (this.seq !== null && d.seqLast !== null && d.seqLast <= this.seq) return "ignored_stale";
    if (this.seq !== null) {
      let ok: boolean;
      if (d.prevSeq !== null) ok = d.prevSeq === this.seq;
      else if (d.seqFirst !== null && d.seqLast !== null) ok = d.seqFirst <= this.seq + 1 && this.seq + 1 <= d.seqLast;
      else ok = true;
      if (!ok) {
        this.valid = false;
        this.gaps++;
        return "gap";
      }
    }
    const mid = this.mid();
    const band = mid ? (mid * churnBandBps) / 10_000 : Infinity;
    for (const [p, q] of d.bids) this.setLevel(this.bids, p, q, "bid", mid, band);
    for (const [p, q] of d.asks) this.setLevel(this.asks, p, q, "ask", mid, band);
    if (d.bids.length) this.sortedBids = null;
    if (d.asks.length) this.sortedAsks = null;
    if (d.seqLast !== null) this.seq = d.seqLast;
    this.lastUpdateTs = d.recvTs;
    this.lastExchTs = d.exchTs;
    this.updates++;
    // Crossed book after applying = corrupted state. Invalidate rather than publish garbage.
    const bb = this.bestBid();
    const ba = this.bestAsk();
    if (bb && ba && bb[0] >= ba[0]) {
      this.uncross(bb[0], ba[0]);
    }
    return "applied";
  }

  /** Some venues (e.g. Hyperliquid, Bitfinex trade-through) can leave transiently crossed levels; drop the stale side. */
  private uncross(bid: number, ask: number) {
    // Remove levels that are through the other side's touch: keep the most recent side intact.
    for (const p of [...this.bids.keys()]) if (p >= ask) this.bids.delete(p);
    if (this.bestBid()?.[0] === bid && bid >= ask) for (const p of [...this.asks.keys()]) if (p <= bid) this.asks.delete(p);
    this.sortedBids = this.sortedAsks = null;
  }

  private setLevel(side: Map<number, number>, p: number, q: number, s: "bid" | "ask", mid: number | null, band: number) {
    const prev = side.get(p) ?? 0;
    if (q <= 0) side.delete(p);
    else side.set(p, q);
    if (mid !== null && Math.abs(p - mid) <= band) {
      const diff = q - prev;
      if (s === "bid") diff > 0 ? (this.churn.bidAdd += diff) : (this.churn.bidRemove -= diff);
      else diff > 0 ? (this.churn.askAdd += diff) : (this.churn.askRemove -= diff);
    }
  }

  invalidate() {
    this.valid = false;
  }

  getBids(): BookLevel[] {
    if (!this.sortedBids) this.sortedBids = [...this.bids.entries()].sort((a, b) => b[0] - a[0]);
    return this.sortedBids;
  }
  getAsks(): BookLevel[] {
    if (!this.sortedAsks) this.sortedAsks = [...this.asks.entries()].sort((a, b) => a[0] - b[0]);
    return this.sortedAsks;
  }
  bestBid(): BookLevel | null {
    return this.getBids()[0] ?? null;
  }
  bestAsk(): BookLevel | null {
    return this.getAsks()[0] ?? null;
  }
  mid(): number | null {
    const b = this.bestBid();
    const a = this.bestAsk();
    return b && a ? (b[0] + a[0]) / 2 : null;
  }
  spreadBps(): number | null {
    const b = this.bestBid();
    const a = this.bestAsk();
    const m = this.mid();
    return b && a && m ? ((a[0] - b[0]) / m) * 10_000 : null;
  }
  /** Size-weighted microprice: tilts mid toward the thinner side's opposite. */
  microprice(): number | null {
    const b = this.bestBid();
    const a = this.bestAsk();
    if (!b || !a) return null;
    const tot = b[1] + a[1];
    if (tot <= 0) return null;
    return (a[0] * b[1] + b[0] * a[1]) / tot;
  }
  get levelCount() {
    return this.bids.size + this.asks.size;
  }
}

export interface DepthProfile {
  /** bps distances from mid used for bands */
  bands: number[];
  /** cumulative base size within band */
  bid: number[];
  ask: number[];
  /** cumulative USD notional within band */
  bidUsd: number[];
  askUsd: number[];
}

export const STANDARD_BANDS_BPS = [5, 10, 25, 50, 100, 200, 500];

/** Cumulative depth at standardized basis-point distances from mid. */
export function depthProfile(book: L2Book, bands = STANDARD_BANDS_BPS): DepthProfile | null {
  const mid = book.mid();
  if (mid === null || !book.valid) return null;
  const out: DepthProfile = { bands, bid: bands.map(() => 0), ask: bands.map(() => 0), bidUsd: bands.map(() => 0), askUsd: bands.map(() => 0) };
  const maxBand = bands[bands.length - 1];
  for (const [p, q] of book.getBids()) {
    const d = ((mid - p) / mid) * 10_000;
    if (d > maxBand) break;
    for (let i = 0; i < bands.length; i++) if (d <= bands[i]) { out.bid[i] += q; out.bidUsd[i] += p * q; }
  }
  for (const [p, q] of book.getAsks()) {
    const d = ((p - mid) / mid) * 10_000;
    if (d > maxBand) break;
    for (let i = 0; i < bands.length; i++) if (d <= bands[i]) { out.ask[i] += q; out.askUsd[i] += p * q; }
  }
  return out;
}

/** (bid - ask) / (bid + ask) within a band. Range [-1, 1]; positive = bid-heavy. */
export function imbalance(profile: DepthProfile, bandIdx: number): number | null {
  const b = profile.bidUsd[bandIdx];
  const a = profile.askUsd[bandIdx];
  return b + a > 0 ? (b - a) / (b + a) : null;
}

/**
 * Order-book slope: USD depth added per bps of distance, via least squares on cumulative
 * depth vs distance. Higher slope = deeper, more resilient side.
 */
export function bookSlope(profile: DepthProfile, side: "bid" | "ask"): number | null {
  const ys = side === "bid" ? profile.bidUsd : profile.askUsd;
  const xs = profile.bands;
  const n = xs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
  const den = n * sxx - sx * sx;
  return den === 0 ? null : (n * sxy - sx * sy) / den;
}

/**
 * Walk the book to estimate execution of a market order of `usd` notional.
 * Returns average fill price, slippage vs mid in bps, and whether the visible book was exhausted.
 */
export function simulateMarketOrder(book: L2Book, side: "buy" | "sell", usd: number) {
  const mid = book.mid();
  if (mid === null || !book.valid) return null;
  const levels = side === "buy" ? book.getAsks() : book.getBids();
  let remaining = usd, cost = 0, qty = 0, last = mid;
  for (const [p, q] of levels) {
    const lvlUsd = p * q;
    const take = Math.min(lvlUsd, remaining);
    cost += take;
    qty += take / p;
    remaining -= take;
    last = p;
    if (remaining <= 1e-9) break;
  }
  if (qty === 0) return null;
  const avg = cost / qty;
  return {
    avgPrice: avg,
    worstPrice: last,
    slippageBps: (side === "buy" ? (avg - mid) / mid : (mid - avg) / mid) * 10_000,
    exhausted: remaining > 1e-9,
    filledUsd: usd - remaining,
  };
}

/** Aggregate many venue books into one consolidated ladder bucketed at `tick` USD. */
export function consolidate(books: L2Book[], tick: number, rangeBps = 200) {
  const mids = books.map((b) => b.mid()).filter((m): m is number => m !== null);
  if (!mids.length) return null;
  mids.sort((a, b) => a - b);
  const mid = mids[Math.floor(mids.length / 2)];
  const lo = mid * (1 - rangeBps / 10_000);
  const hi = mid * (1 + rangeBps / 10_000);
  const bids = new Map<number, number>();
  const asks = new Map<number, number>();
  for (const b of books) {
    if (!b.valid) continue;
    for (const [p, q] of b.getBids()) { if (p < lo) break; const k = Math.floor(p / tick) * tick; bids.set(k, (bids.get(k) ?? 0) + q); }
    for (const [p, q] of b.getAsks()) { if (p > hi) break; const k = Math.ceil(p / tick) * tick; asks.set(k, (asks.get(k) ?? 0) + q); }
  }
  return { mid, bids, asks };
}

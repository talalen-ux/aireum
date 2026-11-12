import type { FeedState, InstrumentRef, MarketType, QualityFlag, TradeEvent, Venue } from "../core/types";
import { L2Book, bookSlope, depthProfile, imbalance, simulateMarketOrder, STANDARD_BANDS_BPS } from "../core/orderbook";
import { linreg, median, pearson, RingBuffer } from "../core/stats";

/** Live state for one venue × market stream. */
export class Stream {
  book = new L2Book();
  state: FeedState = "connecting";
  stateDetail = "";
  lastMsg = 0;
  lastTrade: TradeEvent | null = null;
  latencies = new RingBuffer(200);
  trades = 0;
  dupes = 0;
  qualityFlags = new Set<QualityFlag>();
  /** per-second mid samples for lead-lag (aligned to wall-clock second) */
  midBySec = new Map<number, number>();
  /** churn snapshots per second for replenishment rate */
  churnHist: { t: number; bidAdd: number; bidRemove: number; askAdd: number; askRemove: number }[] = [];
  imbHist: { t: number; v: number }[] = [];
  oiBase: number | null = null;
  oiUsd: number | null = null;
  funding: number | null = null;
  fundingInterval: number | null = null;
  nextFunding: number | null = null;
  mark: number | null = null;
  index: number | null = null;
  constructor(readonly inst: InstrumentRef) {}
  get key() {
    return streamKey(this.inst.venue, this.inst.market);
  }
}

export const streamKey = (v: Venue, m: MarketType) => `${v}:${m}`;

export interface VenueRow {
  key: string;
  venue: Venue;
  market: MarketType;
  symbol: string;
  state: FeedState;
  detail: string;
  mid: number | null;
  spreadBps: number | null;
  microprice: number | null;
  /** deviation from cross-venue median mid, bps */
  dislocationBps: number | null;
  imb10: number | null;
  imb25: number | null;
  imb100: number | null;
  depthBid25Usd: number | null;
  depthAsk25Usd: number | null;
  depthBid100Usd: number | null;
  depthAsk100Usd: number | null;
  slopeBid: number | null;
  slopeAsk: number | null;
  bidReplenish: number | null;
  askReplenish: number | null;
  latencyMs: number | null;
  ageMs: number | null;
  gaps: number;
  levels: number;
  oiUsd: number | null;
  funding8h: number | null;
  mark: number | null;
  index: number | null;
  markIndexBps: number | null;
  slip1mBuyBps: number | null;
  slip1mSellBps: number | null;
  flags: QualityFlag[];
}

export function venueRow(s: Stream, now: number, medianMid: number | null): VenueRow {
  const b = s.book;
  const prof = b.valid ? depthProfile(b) : null;
  const idx = (bp: number) => STANDARD_BANDS_BPS.indexOf(bp);
  const mid = b.valid ? b.mid() : s.lastTrade?.price ?? null;
  const rep = replenishment(s, now);
  const slipB = b.valid ? simulateMarketOrder(b, "buy", 1_000_000) : null;
  const slipS = b.valid ? simulateMarketOrder(b, "sell", 1_000_000) : null;
  const lat = s.latencies.length ? median(s.latencies.toArray()) : null;
  const f8 = s.funding !== null && s.fundingInterval ? s.funding * (8 / s.fundingInterval) : s.funding;
  return {
    key: s.key, venue: s.inst.venue, market: s.inst.market, symbol: s.inst.symbol, state: s.state, detail: s.stateDetail,
    mid, spreadBps: b.valid ? b.spreadBps() : null, microprice: b.valid ? b.microprice() : null,
    dislocationBps: mid !== null && medianMid ? ((mid - medianMid) / medianMid) * 10_000 : null,
    imb10: prof ? imbalance(prof, idx(10)) : null, imb25: prof ? imbalance(prof, idx(25)) : null, imb100: prof ? imbalance(prof, idx(100)) : null,
    depthBid25Usd: prof ? prof.bidUsd[idx(25)] : null, depthAsk25Usd: prof ? prof.askUsd[idx(25)] : null,
    depthBid100Usd: prof ? prof.bidUsd[idx(100)] : null, depthAsk100Usd: prof ? prof.askUsd[idx(100)] : null,
    slopeBid: prof ? bookSlope(prof, "bid") : null, slopeAsk: prof ? bookSlope(prof, "ask") : null,
    bidReplenish: rep.bid, askReplenish: rep.ask,
    latencyMs: lat, ageMs: s.lastMsg ? now - s.lastMsg : null, gaps: b.gaps, levels: b.levelCount,
    oiUsd: s.oiUsd, funding8h: f8, mark: s.mark, index: s.index,
    markIndexBps: s.mark && s.index ? ((s.mark - s.index) / s.index) * 10_000 : null,
    slip1mBuyBps: slipB && !slipB.exhausted ? slipB.slippageBps : null,
    slip1mSellBps: slipS && !slipS.exhausted ? slipS.slippageBps : null,
    flags: [...s.qualityFlags],
  };
}

/** adds / (adds + removes) within ±25bp over the last 60s. */
export function replenishment(s: Stream, now: number) {
  const h = s.churnHist;
  if (h.length < 5) return { bid: null, ask: null };
  const cur = s.book.churn;
  let base = h[0];
  for (const x of h) if (x.t >= now - 60_000) { base = x; break; }
  const ba = cur.bidAdd - base.bidAdd, br = cur.bidRemove - base.bidRemove, aa = cur.askAdd - base.askAdd, ar = cur.askRemove - base.askRemove;
  return { bid: ba + br > 0 ? ba / (ba + br) : null, ask: aa + ar > 0 ? aa / (aa + ar) : null };
}

/** Per-second sampling tasks (called once per second by the engine). */
export function sampleStream(s: Stream, now: number) {
  const sec = Math.floor(now / 1000);
  const mid = s.book.valid ? s.book.mid() : null;
  if (mid !== null) s.midBySec.set(sec, mid);
  if (s.midBySec.size > 600) {
    const cutoff = sec - 600;
    for (const k of s.midBySec.keys()) if (k < cutoff) s.midBySec.delete(k);
  }
  s.churnHist.push({ t: now, ...s.book.churn });
  if (s.churnHist.length > 180) s.churnHist.shift();
  if (s.book.valid) {
    const prof = depthProfile(s.book);
    const v = prof ? imbalance(prof, STANDARD_BANDS_BPS.indexOf(25)) : null;
    if (v !== null) s.imbHist.push({ t: now, v });
    if (s.imbHist.length > 300) s.imbHist.shift();
  }
}

/**
 * Cross-venue lead-lag. For each pair, cross-correlate 1s log mid returns at lags
 * −L..+L over the last `win` seconds. The venue whose returns best predict others'
 * future returns is the leader. Reports the best lag in seconds and the correlation.
 */
export interface LeadLag {
  leader: string | null;
  scores: { key: string; leadScore: number; n: number }[];
  pairs: { a: string; b: string; lagSec: number; corr: number }[];
  windowSec: number;
}

export function computeLeadLag(streams: Stream[], now: number, win = 300, L = 5): LeadLag {
  const sec = Math.floor(now / 1000);
  const series: { key: string; r: number[] }[] = [];
  for (const s of streams) {
    if (s.midBySec.size < win / 2) continue;
    const r: number[] = [];
    let prev: number | undefined;
    for (let t = sec - win; t <= sec; t++) {
      const m = s.midBySec.get(t) ?? prev;
      const p = prev;
      r.push(m !== undefined && p !== undefined ? Math.log(m / p) : 0);
      prev = m;
    }
    series.push({ key: s.key, r });
  }
  const pairs: LeadLag["pairs"] = [];
  const lead = new Map<string, { s: number; n: number }>();
  for (let i = 0; i < series.length; i++) {
    for (let j = i + 1; j < series.length; j++) {
      const a = series[i], b = series[j];
      let best = { lag: 0, c: -Infinity };
      for (let lag = -L; lag <= L; lag++) {
        // positive lag: a leads b (a at t, b at t+lag)
        const xa: number[] = [], xb: number[] = [];
        for (let t = Math.max(0, -lag); t < a.r.length && t + lag < b.r.length; t++) { xa.push(a.r[t]); xb.push(b.r[t + lag]); }
        const c = pearson(xa, xb);
        if (c !== null && c > best.c) best = { lag, c };
      }
      if (best.c === -Infinity) continue;
      pairs.push({ a: a.key, b: b.key, lagSec: best.lag, corr: best.c });
      const la = lead.get(a.key) ?? { s: 0, n: 0 }, lb = lead.get(b.key) ?? { s: 0, n: 0 };
      la.s += best.lag * best.c; lb.s -= best.lag * best.c; la.n++; lb.n++;
      lead.set(a.key, la); lead.set(b.key, lb);
    }
  }
  const scores = [...lead.entries()].map(([key, v]) => ({ key, leadScore: v.n ? v.s / v.n : 0, n: v.n })).sort((x, y) => y.leadScore - x.leadScore);
  return { leader: scores.length && scores[0].leadScore > 0.15 ? scores[0].key : null, scores, pairs, windowSec: win };
}

/**
 * Price-impact asymmetry: regress 10s mid return (bps) on 10s signed USD flow separately
 * for buy-dominant and sell-dominant intervals → bps per $1M aggressive buying vs selling.
 */
export class ImpactTracker {
  private buckets = new Map<number, { buy: number; sell: number }>();
  private mids = new Map<number, number>();
  onTrade(ts: number, usd: number, side: "buy" | "sell") {
    const k = Math.floor(ts / 10_000);
    const b = this.buckets.get(k) ?? { buy: 0, sell: 0 };
    b[side] += usd;
    this.buckets.set(k, b);
  }
  onMid(ts: number, mid: number) {
    this.mids.set(Math.floor(ts / 10_000), mid);
  }
  compute(now: number, windowBuckets = 90) {
    const k1 = Math.floor(now / 10_000);
    const bx: number[] = [], by: number[] = [], sx: number[] = [], sy: number[] = [];
    for (let k = k1 - windowBuckets; k < k1; k++) {
      const f = this.buckets.get(k), m0 = this.mids.get(k - 1), m1 = this.mids.get(k);
      if (!f || !m0 || !m1) continue;
      const net = (f.buy - f.sell) / 1e6;
      const r = Math.log(m1 / m0) * 10_000;
      if (net > 0) { bx.push(net); by.push(r); } else if (net < 0) { sx.push(-net); sy.push(-r); }
    }
    for (const k of this.buckets.keys()) if (k < k1 - windowBuckets - 2) this.buckets.delete(k);
    for (const k of this.mids.keys()) if (k < k1 - windowBuckets - 2) this.mids.delete(k);
    const through = (xs: number[], ys: number[]) => {
      if (xs.length < 6) return null;
      // regression through origin: bps per $1M
      let sxy = 0, sxx = 0;
      for (let i = 0; i < xs.length; i++) { sxy += xs[i] * ys[i]; sxx += xs[i] ** 2; }
      return sxx > 0 ? sxy / sxx : null;
    };
    const lrB = linreg(bx, by), lrS = linreg(sx, sy);
    return {
      buyBpsPer1M: through(bx, by),
      sellBpsPer1M: through(sx, sy),
      nBuy: bx.length,
      nSell: sx.length,
      r2Buy: lrB?.r2 ?? null,
      r2Sell: lrS?.r2 ?? null,
      windowSec: windowBuckets * 10,
    };
  }
}

/** Large-trade detector: trades above max(fixed floor, rolling p99.5 USD size). */
export class LargeTrades {
  private sizes = new RingBuffer(5000);
  readonly tape: { ts: number; venue: Venue; market: MarketType; side: "buy" | "sell"; price: number; usd: number; size: number }[] = [];
  private cached: number;
  private sinceCalc = 0;
  constructor(readonly floorUsd: number) {
    this.cached = floorUsd;
  }
  /** max(floor, rolling p99.5) — recomputed every 250 trades, not per trade. */
  threshold() {
    if (this.sizes.length < 500) return this.floorUsd;
    if (this.sinceCalc++ % 250 === 0) {
      const arr = this.sizes.toArray().sort((a, b) => a - b);
      this.cached = Math.max(this.floorUsd, arr[Math.floor(arr.length * 0.995)]);
    }
    return this.cached;
  }
  onTrade(t: TradeEvent) {
    const usd = t.price * t.size;
    this.sizes.push(usd);
    if (usd >= this.threshold()) {
      this.tape.unshift({ ts: t.exchTs ?? t.recvTs, venue: t.inst.venue, market: t.inst.market, side: t.side, price: t.price, usd, size: t.size });
      if (this.tape.length > 60) this.tape.pop();
    }
  }
}

/** Wall persistence & spoof-like behaviour (UNVERIFIED): large levels that vanish as price approaches. */
export interface WallInfo {
  key: string;
  side: "bid" | "ask";
  price: number;
  usd: number;
  firstSeen: number;
  ageSec: number;
  distBps: number;
}

export class WallTracker {
  private walls = new Map<string, { side: "bid" | "ask"; price: number; usd: number; firstSeen: number; minDist: number; venue: string }>();
  readonly pulled: { ts: number; venue: string; side: "bid" | "ask"; price: number; usd: number; distBps: number }[] = [];
  update(key: string, book: L2Book, now: number, minUsd: number) {
    const mid = book.mid();
    if (!mid || !book.valid) return;
    const seen = new Set<string>();
    const scan = (levels: [number, number][], side: "bid" | "ask") => {
      for (const [p, q] of levels) {
        const dist = Math.abs(p - mid) / mid * 10_000;
        if (dist > 150) break;
        const usd = p * q;
        if (usd < minUsd) continue;
        const id = `${key}|${side}|${p}`;
        seen.add(id);
        const w = this.walls.get(id);
        if (w) { w.usd = usd; w.minDist = Math.min(w.minDist, dist); } else this.walls.set(id, { side, price: p, usd, firstSeen: now, minDist: dist, venue: key });
      }
    };
    scan(book.getBids(), "bid");
    scan(book.getAsks(), "ask");
    for (const [id, w] of this.walls) {
      if (!id.startsWith(key + "|") || seen.has(id)) continue;
      const dist = Math.abs(w.price - mid) / mid * 10_000;
      const traded = (w.side === "bid" && mid <= w.price) || (w.side === "ask" && mid >= w.price);
      // pulled while price was approaching (within 15bp) and not traded through, after persisting ≥10s
      if (!traded && w.minDist <= 15 && now - w.firstSeen > 10_000) {
        this.pulled.unshift({ ts: now, venue: w.venue, side: w.side, price: w.price, usd: w.usd, distBps: dist });
        if (this.pulled.length > 30) this.pulled.pop();
      }
      this.walls.delete(id);
    }
  }
  list(now: number, mid: number | null): WallInfo[] {
    if (!mid) return [];
    return [...this.walls.entries()]
      .map(([k, w]) => ({ key: k, side: w.side, price: w.price, usd: w.usd, firstSeen: w.firstSeen, ageSec: (now - w.firstSeen) / 1000, distBps: ((w.price - mid) / mid) * 10_000 }))
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 16);
  }
}

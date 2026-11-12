import type { AnyEvent, Asset, InstrumentRef, MarketType, Timeframe, Venue, VenueAdapter } from "../core/types";
import { TF_MS, TIMEFRAMES } from "../core/types";
import { gaussian, mulberry32 } from "../core/stats";
import type { Bar } from "../engine/bars";
import { emptyBar } from "../engine/bars";

/**
 * SYNTHETIC MARKET SIMULATOR — every event it emits is fake and the whole app is
 * labeled SIMULATION while it runs. It exists so the full pipeline (books with
 * sequence numbers and injected gaps, trades, liquidations, OI, funding) can be
 * exercised and demonstrated offline, including planted exhaustion episodes.
 *
 * Phases cycle through a scripted market: range → selloff → exhaustion → reversal
 * → grind up → blow-off → absorption at highs → ...
 */
type PhaseId = "range" | "selloff" | "exhaustion" | "reversal" | "grind_up" | "blowoff" | "absorption_top";
interface Phase { id: PhaseId; secs: number; bias: number; impact: number; vol: number; oiDrift: number; liq: "long" | "short" | null; liqRate: number; bidRefill: number; askRefill: number; funding: number; activity: number }

const PHASES: Phase[] = [
  { id: "range", secs: 150, bias: 0, impact: 1, vol: 1, oiDrift: 0.00002, liq: null, liqRate: 0, bidRefill: 0.5, askRefill: 0.5, funding: 0.0001, activity: 1 },
  { id: "selloff", secs: 140, bias: -0.35, impact: 1.6, vol: 1.6, oiDrift: 0.00006, liq: "long", liqRate: 0.25, bidRefill: 0.35, askRefill: 0.6, funding: 0.00012, activity: 1.8 },
  { id: "exhaustion", secs: 120, bias: -0.3, impact: 0.35, vol: 0.9, oiDrift: -0.00012, liq: "long", liqRate: 0.12, bidRefill: 0.72, askRefill: 0.45, funding: 0.00003, activity: 1.6 },
  { id: "reversal", secs: 110, bias: 0.3, impact: 1.3, vol: 1.3, oiDrift: -0.00003, liq: "short", liqRate: 0.15, bidRefill: 0.6, askRefill: 0.4, funding: 0.00002, activity: 1.5 },
  { id: "grind_up", secs: 150, bias: 0.15, impact: 1, vol: 0.9, oiDrift: 0.00005, liq: null, liqRate: 0, bidRefill: 0.55, askRefill: 0.45, funding: 0.00009, activity: 1.1 },
  { id: "blowoff", secs: 100, bias: 0.38, impact: 1.5, vol: 1.6, oiDrift: 0.0001, liq: "short", liqRate: 0.2, bidRefill: 0.45, askRefill: 0.35, funding: 0.00025, activity: 1.9 },
  { id: "absorption_top", secs: 120, bias: 0.3, impact: 0.3, vol: 0.8, oiDrift: -0.0001, liq: "short", liqRate: 0.08, bidRefill: 0.42, askRefill: 0.72, funding: 0.00018, activity: 1.6 },
];

interface SimVenue { lastBest?: number; venue: Venue; market: MarketType; lag: number; disloc: number; rate: number; book: { bids: Map<number, number>; asks: Map<number, number> }; seq: number; oi: number; inst: InstrumentRef; tradeId: number }

export const SIM_VENUES: [Venue, MarketType, number, number][] = [
  // venue, market, lag (steps of 100ms), activity weight
  ["binance", "perp", 0, 1.6],
  ["binance", "spot", 2, 1.0],
  ["bybit", "perp", 1, 1.0],
  ["okx", "perp", 2, 0.7],
  ["okx", "spot", 4, 0.4],
  ["coinbase", "spot", 3, 0.7],
  ["hyperliquid", "perp", 5, 0.5],
];

export class Simulator implements VenueAdapter {
  readonly venue: Venue = "sim";
  readonly instruments: InstrumentRef[];
  private rand: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private emit: (e: AnyEvent) => void = () => {};
  private venues: SimVenue[];
  private fair: number;
  private fairHist: number[] = [];
  private phaseIdx = 0;
  private phaseT = 0;
  private step = 0;
  private funding = 0.0001;
  private tick: number;
  private pendingGap: { v: SimVenue; at: number } | null = null;
  private nextGapStep = 600;

  constructor(readonly asset: Asset, readonly startPrice = asset === "BTC" ? 100_000 : 3_500, seed = 42) {
    this.rand = mulberry32(seed);
    this.fair = startPrice;
    this.tick = asset === "BTC" ? 5 : 0.25;
    this.venues = SIM_VENUES.map(([venue, market, lag, rate]) => {
      const inst: InstrumentRef = { venue, symbol: `${asset}-SIM-${market.toUpperCase()}`, asset, market, contract: market === "spot" ? "spot" : "linear", quote: "USD", multiplier: 1 };
      return { venue, market, lag, disloc: (this.rand() - 0.5) * 2e-4, rate, book: { bids: new Map(), asks: new Map() }, seq: 1000, oi: market === "perp" ? (asset === "BTC" ? 60_000 : 900_000) * rate : 0, inst, tradeId: 1 };
    });
    this.instruments = this.venues.map((v) => v.inst);
  }

  get phase() {
    return PHASES[this.phaseIdx];
  }

  start(emit: (e: AnyEvent) => void) {
    this.emit = emit;
    const now = Date.now();
    for (const v of this.venues) {
      this.emit({ kind: "feed_status", venue: v.venue, symbol: v.inst.symbol, market: v.market, state: "syncing", ts: now, detail: "SIMULATION" });
      this.snapshot(v, now);
    }
    this.timer = setInterval(() => this.stepOnce(), 100);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private meta(v: SimVenue, now: number, source: string) {
    return { inst: v.inst, exchTs: now - 5 - Math.floor(this.rand() * 20), recvTs: now, source: `sim:${v.venue}.${v.market}.${source}`, quality: ["ok" as const] };
  }

  private midFor(v: SimVenue) {
    const h = this.fairHist;
    const f = h.length > v.lag ? h[h.length - 1 - v.lag] : this.fair;
    const basis = v.market === "perp" ? this.funding * 2 : 0;
    return f * (1 + v.disloc + basis);
  }

  private snapshot(v: SimVenue, now: number) {
    const mid = this.midFor(v);
    v.book.bids.clear(); v.book.asks.clear();
    const t = this.tick;
    const bb = Math.floor(mid / t) * t, ba = bb + t;
    for (let i = 0; i < 300; i++) {
      v.book.bids.set(round(bb - i * t), this.levelSize(i, v));
      v.book.asks.set(round(ba + i * t), this.levelSize(i, v));
    }
    v.seq += 1;
    this.emit({ kind: "book_snapshot", ...this.meta(v, now, "book"), bids: [...v.book.bids.entries()].sort((a, b) => b[0] - a[0]), asks: [...v.book.asks.entries()].sort((a, b) => a[0] - b[0]), seq: v.seq });
    this.emit({ kind: "feed_status", venue: v.venue, symbol: v.inst.symbol, market: v.market, state: "live", ts: now, detail: "SIMULATION" });
  }

  private levelSize(i: number, v: SimVenue) {
    const base = (this.asset === "BTC" ? 0.6 : 9) * v.rate;
    const wall = this.rand() < 0.015 ? 8 + this.rand() * 25 : 1;
    return +(base * (0.3 + this.rand() * 1.4) * (1 + i / 60) * wall).toFixed(4);
  }

  private stepOnce() {
    const now = Date.now();
    this.step++;
    const ph = this.phase;
    this.phaseT += 0.1;
    if (this.phaseT >= ph.secs) { this.phaseT = 0; this.phaseIdx = (this.phaseIdx + 1) % PHASES.length; }
    this.funding += (ph.funding - this.funding) * 0.002;

    // ---- trades on each venue & fair-price update from net flow
    let netFlow = 0;
    for (const v of this.venues) {
      const lambda = 0.9 * v.rate * ph.activity;
      const n = poisson(lambda, this.rand);
      const mid = this.midFor(v);
      for (let k = 0; k < n; k++) {
        const pBuy = 0.5 + ph.bias * (v.market === "spot" && (ph.id === "exhaustion" || ph.id === "absorption_top") ? 0.4 : 1) / 2;
        const side = this.rand() < pBuy ? "buy" : "sell";
        const big = this.rand() < 0.01 ? 15 + this.rand() * 60 : 1;
        const size = +(Math.exp(gaussian(this.rand) * 1.1) * (this.asset === "BTC" ? 0.04 : 0.6) * big).toFixed(4);
        const bb = maxKey(v.book.bids), ba = minKey(v.book.asks);
        const price = side === "buy" ? ba ?? mid : bb ?? mid;
        netFlow += side === "buy" ? size : -size;
        this.emit({ kind: "trade", ...this.meta(v, now, "trade"), id: `${v.tradeId++}`, price, size, side });
      }
    }
    const unit = this.asset === "BTC" ? 1 : 15;
    const sigma = this.fair * 0.00006 * ph.vol;
    const dImpact = this.fair * 0.00009 * ph.impact * (netFlow / unit);
    this.fair = Math.max(1, this.fair + dImpact + gaussian(this.rand) * sigma + this.fair * ph.bias * 0.000012 * ph.impact);
    this.fairHist.push(this.fair);
    if (this.fairHist.length > 50) this.fairHist.shift();

    // ---- book deltas
    for (const v of this.venues) this.bookStep(v, now, ph);

    // ---- injected sequence gap (tests gap detection → resync path)
    if (this.step >= this.nextGapStep) {
      const v = this.venues[Math.floor(this.rand() * this.venues.length)];
      v.seq += 3; // skip sequence numbers: the next delta will not chain
      this.pendingGap = { v, at: this.step + 5 };
      this.nextGapStep = this.step + 900 + Math.floor(this.rand() * 600);
    }
    if (this.pendingGap && this.step >= this.pendingGap.at) {
      const v = this.pendingGap.v;
      this.emit({ kind: "feed_status", venue: v.venue, symbol: v.inst.symbol, market: v.market, state: "gap_recovering", ts: now, detail: "SIMULATION: injected sequence gap → resync" });
      this.snapshot(v, now);
      this.pendingGap = null;
    }

    // ---- liquidations
    if (ph.liq && this.rand() < ph.liqRate) {
      const perps = this.venues.filter((v) => v.market === "perp" && v.venue !== "hyperliquid");
      const v = perps[Math.floor(this.rand() * perps.length)];
      const size = +(Math.exp(gaussian(this.rand)) * (this.asset === "BTC" ? 0.4 : 6)).toFixed(3);
      this.emit({ kind: "liquidation", ...this.meta(v, now, "liq"), price: this.midFor(v), size, positionSide: ph.liq });
    }

    // ---- OI / funding / mark every second
    if (this.step % 10 === 0) {
      for (const v of this.venues) {
        if (v.market !== "perp") continue;
        v.oi *= 1 + ph.oiDrift * 10 + gaussian(this.rand) * 0.00008;
        const mid = this.midFor(v);
        this.emit({ kind: "open_interest", ...this.meta(v, now, "oi"), oiBase: v.oi, oiUsd: v.oi * mid });
        if (this.step % 50 === 0) this.emit({ kind: "funding", ...this.meta(v, now, "funding"), rate: v.venue === "hyperliquid" ? this.funding / 8 : this.funding, intervalHours: v.venue === "hyperliquid" ? 1 : 8, nextFundingTs: Math.ceil(now / 28_800_000) * 28_800_000 });
        this.emit({ kind: "mark_index", ...this.meta(v, now, "mark"), mark: mid, index: this.fair, last: mid });
      }
    }
  }

  private bookStep(v: SimVenue, now: number, ph: Phase) {
    const mid = this.midFor(v);
    const t = this.tick;
    const bids: [number, number][] = [], asks: [number, number][] = [];
    const bestBid = Math.floor(mid / t) * t;
    const bestAsk = bestBid + t;
    // remove crossed levels
    for (const p of [...v.book.bids.keys()]) if (p > bestBid + 1e-9) { v.book.bids.delete(p); bids.push([p, 0]); }
    for (const p of [...v.book.asks.keys()]) if (p < bestAsk - 1e-9) { v.book.asks.delete(p); asks.push([p, 0]); }
    // trim far levels
    for (const p of [...v.book.bids.keys()]) if (p < bestBid - 320 * t) { v.book.bids.delete(p); bids.push([p, 0]); }
    for (const p of [...v.book.asks.keys()]) if (p > bestAsk + 320 * t) { v.book.asks.delete(p); asks.push([p, 0]); }
    // fill missing levels (only needed when the touch moved)
    const moved = v.lastBest !== bestBid;
    v.lastBest = bestBid;
    for (let i = 0; moved && i < 300; i++) {
      const bp = round(bestBid - i * t), ap = round(bestAsk + i * t);
      if (!v.book.bids.has(bp)) { const q = this.levelSize(i, v); v.book.bids.set(bp, q); bids.push([bp, q]); }
      if (!v.book.asks.has(ap)) { const q = this.levelSize(i, v); v.book.asks.set(ap, q); asks.push([ap, q]); }
    }
    // churn near touch: additions vs cancellations biased by phase refill rates
    const churnN = 6;
    for (let k = 0; k < churnN; k++) {
      const i = Math.floor(Math.pow(this.rand(), 2) * 40);
      const side = this.rand() < 0.5 ? "bid" : "ask";
      const p = round(side === "bid" ? bestBid - i * t : bestAsk + i * t);
      const m = side === "bid" ? v.book.bids : v.book.asks;
      const cur = m.get(p) ?? 0;
      const refill = side === "bid" ? ph.bidRefill : ph.askRefill;
      const add = this.rand() < refill;
      const q = Math.max(0.001, +(cur * (add ? 1 + this.rand() * 0.6 : 1 - this.rand() * 0.5)).toFixed(4));
      m.set(p, q);
      (side === "bid" ? bids : asks).push([p, q]);
    }
    if (!bids.length && !asks.length) return;
    const prev = v.seq;
    v.seq += 1;
    this.emit({ kind: "book_delta", ...this.meta(v, now, "book"), bids, asks, seqFirst: v.seq, seqLast: v.seq, prevSeq: prev });
  }

  /** Synthetic multi-timeframe history ending at the simulator's start price (labeled synthetic). */
  history(now = Date.now()): Partial<Record<Timeframe, Bar[]>> {
    const out: Partial<Record<Timeframe, Bar[]>> = {};
    TIMEFRAMES.forEach((tf, k) => (out[tf] = synthBars(tf, tf === "1w" ? 300 : 1000, this.startPrice, now, 1000 + k, this.asset)));
    return out;
  }
}

function synthBars(tf: Timeframe, n: number, endPrice: number, now: number, seed: number, asset: Asset): Bar[] {
  const r = mulberry32(seed);
  const ms = TF_MS[tf];
  const sigma = 0.0018 * Math.sqrt(ms / 300_000);
  const unitVol = (asset === "BTC" ? 120 : 1800) * (ms / 300_000);
  let px = 1, oi = 1, fund = 0.0001;
  let regime = 0, regimeLeft = 0;
  const raw: Bar[] = [];
  const t0 = Math.floor(now / ms) * ms - (n - 1) * ms;
  for (let i = 0; i < n; i++) {
    if (regimeLeft-- <= 0) { regime = Math.floor(r() * 5); regimeLeft = 15 + Math.floor(r() * 40); }
    // 0 range, 1 trend up, 2 trend down, 3 selloff+exhaustion, 4 squeeze up
    const bias = [0, 0.12, -0.12, regimeLeft > 10 ? -0.3 : -0.25, 0.3][regime];
    const impact = regime === 3 && regimeLeft <= 10 ? 0.3 : 1;
    const vol = unitVol * (0.6 + r() * 0.8) * (regime >= 3 ? 1.6 : 1);
    const pBuy = 0.5 + bias / 2 + (r() - 0.5) * 0.1;
    const spotV = vol * 0.35, perpV = vol * 0.65;
    const spotBias = regime === 3 && regimeLeft <= 10 ? pBuy + 0.12 : pBuy;
    const ret = (pBuy - 0.5) * 2 * sigma * 1.5 * impact + gaussian(r) * sigma;
    const o = px;
    px *= Math.exp(ret);
    const b = emptyBar(t0 + i * ms, o);
    b.o = o; b.c = px;
    b.h = Math.max(o, px) * (1 + Math.abs(gaussian(r)) * sigma * 0.5);
    b.l = Math.min(o, px) * (1 - Math.abs(gaussian(r)) * sigma * 0.5);
    b.spotBuy = spotV * Math.min(0.95, Math.max(0.05, spotBias)); b.spotSell = spotV - b.spotBuy;
    b.perpBuy = perpV * pBuy; b.perpSell = perpV - b.perpBuy;
    oi *= Math.exp((regime === 3 && regimeLeft <= 10 ? -0.004 : regime >= 1 ? 0.0015 : 0) + gaussian(r) * 0.001);
    b.oi = oi;
    fund += ((regime === 1 || regime === 4 ? 0.0002 : regime >= 2 ? 0.00002 : 0.0001) - fund) * 0.05 + gaussian(r) * 0.00001;
    b.funding = fund;
    b.basisBps = fund * 2e4 + gaussian(r) * 0.5;
    if (regime === 3 && r() < 0.4) b.liqLong = vol * 0.02 * r();
    if (regime === 4 && r() < 0.4) b.liqShort = vol * 0.02 * r();
    raw.push(b);
  }
  const k = endPrice / px;
  const oiK = (asset === "BTC" ? 85_000 : 1_400_000) / oi;
  for (const b of raw) { b.o *= k; b.h *= k; b.l *= k; b.c *= k; b.oi = (b.oi ?? 0) * oiK; }
  return raw;
}

function poisson(l: number, r: () => number) {
  const L = Math.exp(-l);
  let k = 0, p = 1;
  do { k++; p *= r(); } while (p > L);
  return k - 1;
}
const round = (x: number) => Math.round(x * 1e6) / 1e6;
function maxKey(m: Map<number, number>) { let x: number | null = null; for (const k of m.keys()) if (x === null || k > x) x = k; return x; }
function minKey(m: Map<number, number>) { let x: number | null = null; for (const k of m.keys()) if (x === null || k < x) x = k; return x; }

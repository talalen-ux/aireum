import type { Evidence, Side, Timeframe } from "../core/types";
import { clamp, robustZ, squash } from "../core/stats";
import type { Bar } from "./bars";
import { atr, perpDelta, spotDelta } from "./bars";
import { evaluateExhaustion, historicalAnalogs, type AnalogStats, type BookPressure, type ExhaustionCondition, type Lifecycle } from "./exhaustion";
import type { TfAssessment } from "./regime";
import type { LiqMap } from "./liqmodel";
import type { VenueRow, LeadLag } from "./micro";
import type { DvolResult } from "./dvol";
import type { VixResult } from "./eventstudy";
import { aggregateVol } from "./dvol";
import { detect2B, williamsVixFix, wvfState, type TwoB } from "./technicals";

export type DetectorId =
  | "liquidation_exhaustion"
  | "passive_absorption"
  | "hidden_accumulation"
  | "short_squeeze"
  | "long_squeeze"
  | "failed_breakdown"
  | "failed_breakout"
  | "funding_divergence"
  | "oi_divergence"
  | "spot_perp_divergence"
  | "cross_venue_dislocation"
  | "options_hedging_event"
  | "macro_shock"
  | "liquidity_vacuum"
  | "price_2b"
  | "vix_2b";

export const DETECTOR_LABEL: Record<DetectorId, string> = {
  liquidation_exhaustion: "Liquidity exhaustion",
  passive_absorption: "Passive absorption",
  hidden_accumulation: "Hidden accumulation / distribution",
  short_squeeze: "Short squeeze setup",
  long_squeeze: "Long squeeze setup",
  failed_breakdown: "Failed breakdown",
  failed_breakout: "Failed breakout",
  funding_divergence: "Funding divergence",
  oi_divergence: "OI divergence",
  spot_perp_divergence: "Spot–perp divergence",
  cross_venue_dislocation: "Cross-venue dislocation",
  options_hedging_event: "Options hedging event",
  macro_shock: "Macro shock",
  liquidity_vacuum: "Liquidity vacuum",
  price_2b: "2B reversal (price)",
  vix_2b: "VIX 2B (volatility)",
};

export interface Opportunity {
  key: string;
  detector: DetectorId;
  side: Side;
  tf: Timeframe | "1m";
  state: Lifecycle;
  strength: number; // evidence strength [0,1] — NOT a probability
  completeness: number; // share of required inputs that were measurable
  thesis: string;
  evidence: Evidence[];
  counter: Evidence[];
  conditions?: ExhaustionCondition[];
  zone: [number, number] | null;
  trigger: number | null;
  invalidation: number | null;
  targets: { price: number; why: string }[];
  analogs: AnalogStats | null;
  assumptions: string[];
  firstSeen: number;
  updated: number;
  /** price at first detection — for audit */
  firstPrice: number;
}

export interface DetectorStatus {
  id: DetectorId;
  available: boolean;
  reason?: string;
}

export interface DetectorContext {
  now: number;
  price: number | null;
  bars1m: Bar[];
  bars: Partial<Record<Timeframe, Bar[]>>;
  assess: Partial<Record<Timeframe, TfAssessment>>;
  book: BookPressure | null;
  venues: VenueRow[];
  leadLag: LeadLag | null;
  liq: LiqMap | null;
  depthHist: { t: number; bid100: number; ask100: number }[];
  analogCache: Map<string, AnalogStats>;
  optionsAvailable: boolean;
  macroAvailable: boolean;
  dvol?: DvolResult | null;
  vix?: VixResult | null;
}

type Candidate = Omit<Opportunity, "key" | "firstSeen" | "updated" | "firstPrice" | "state"> & { state?: Lifecycle };

const ev = (label: string, value: string, stance: 1 | -1 | 0, provenance: Evidence["provenance"], source: string, ts: number): Evidence => ({ label, value, stance, provenance, source, ts });
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

function flowRatio(bars: Bar[], from: number, to: number, which: "spot" | "perp" | "all"): number | null {
  let d = 0, v = 0, ok = false;
  for (let j = Math.max(0, from); j <= to; j++) {
    const b = bars[j];
    const s = spotDelta(b), p = perpDelta(b);
    if (which !== "perp" && s !== null) { d += s; v += (b.spotBuy ?? 0) + (b.spotSell ?? 0); ok = true; }
    if (which !== "spot" && p !== null) { d += p; v += (b.perpBuy ?? 0) + (b.perpSell ?? 0); ok = true; }
  }
  return ok && v > 0 ? d / v : null;
}

function targetsFor(side: Side, price: number, liq: LiqMap | null, extra: { price: number; why: string }[] = []) {
  const t = [...extra];
  if (liq) {
    const c = side === "long" ? liq.nearestShortCluster : liq.nearestLongCluster;
    if (c) t.push({ price: c.price, why: `modeled ${side === "long" ? "short" : "long"}-liquidation cluster (~${(c.usd / 1e6).toFixed(1)}M, MODEL)` });
  }
  return t.filter((x) => (side === "long" ? x.price > price : x.price < price)).slice(0, 3);
}

// ------------------------------------------------------------------ detectors

function exhaustionDetector(ctx: DetectorContext): Candidate[] {
  const out: Candidate[] = [];
  const use1m = ctx.bars1m.length >= 80;
  const series = use1m ? ctx.bars1m : ctx.bars["5m"] ?? [];
  const tf: Timeframe | "1m" = use1m ? "1m" : "5m";
  for (const side of ["long", "short"] as Side[]) {
    const s = evaluateExhaustion(series, side, use1m ? ctx.book : null);
    if (!s || s.strength < 0.3) continue;
    const ana = ctx.analogCache.get(`exh:${side}`) ?? null;
    out.push({
      detector: "liquidation_exhaustion", side, tf, strength: s.strength, completeness: s.completeness, state: s.state,
      thesis: side === "long"
        ? "Sellers are still hitting bids, but each unit of selling moves price less, OI is contracting and spot selling is easing — forced/aggressive supply may be exhausting."
        : "Buyers are still lifting offers, but each unit of buying moves price less, OI is contracting and spot buying is easing — aggressive demand may be getting absorbed.",
      evidence: s.conditions.filter((c) => c.met !== null).map((c) => ev(`${c.id} ${c.label}`, c.detail, (c.met ?? 0) >= 0.5 ? 1 : -1, c.id === "C2" ? "modeled" : "observed", `exhaustion.${c.id}`, s.ts)),
      counter: s.counter,
      conditions: s.conditions,
      zone: s.zone, trigger: s.trigger, invalidation: s.invalidation,
      targets: targetsFor(side, ctx.price ?? s.extreme, ctx.liq),
      analogs: ana,
      assumptions: ["Strength is weighted evidence agreement, not a probability.", "Trigger = reclaim of window structure (earlier than conventional breakout confirmation).", `Invalidation = window extreme ∓ 0.6×ATR(14, ${tf}).`],
    });
  }
  return out;
}

function absorptionDetector(ctx: DetectorContext): Candidate[] {
  const bars = ctx.bars1m.length >= 60 ? ctx.bars1m : null;
  if (!bars || !ctx.price) return [];
  const a = atr(bars, 14);
  if (!a) return [];
  const n = bars.length, W = 6;
  const flow = flowRatio(bars, n - W, n - 1, "all");
  const hist: number[] = [];
  for (let k = W; k < n - W; k += 2) { const f = flowRatio(bars, k - W, k - 1, "all"); if (f !== null) hist.push(f); }
  const z = flow === null ? null : robustZ(flow, hist, 20);
  if (z === null || Math.abs(z) < 1.3) return [];
  const move = bars[n - 1].c - bars[n - W].o;
  const moveAtr = Math.abs(move) / a;
  const aggressorDir = Math.sign(z);
  // absorbed if price failed to move with the flow
  if (moveAtr > 0.5 || Math.sign(move) === aggressorDir && moveAtr > 0.25) return [];
  const side: Side = aggressorDir < 0 ? "long" : "short";
  const rep = side === "long" ? ctx.book?.bidReplenish ?? null : ctx.book?.askReplenish ?? null;
  const strength = clamp(squash((Math.abs(z) - 1.3) * 2) * 0.6 + (1 - moveAtr * 2) * 0.25 + (rep !== null ? (rep - 0.5) * 1.5 : 0), 0, 1);
  const ts = bars[n - 1].t;
  const lo = Math.min(...bars.slice(-W).map((b) => b.l)), hi = Math.max(...bars.slice(-W).map((b) => b.h));
  return [{
    detector: "passive_absorption", side, tf: "1m", strength, completeness: rep === null ? 0.7 : 1,
    thesis: side === "long" ? "Heavy aggressive selling is being met by resting bids — price is not following the flow." : "Heavy aggressive buying is being met by resting offers — price is not following the flow.",
    evidence: [
      ev("Aggressive flow (6m)", `${pct(flow!)} of volume (${z.toFixed(2)}σ)`, 1, "observed", "1m bars", ts),
      ev("Price response", `${(moveAtr).toFixed(2)}×ATR ${move >= 0 ? "up" : "down"}`, 1, "observed", "1m bars", ts),
      ...(rep !== null ? [ev(`${side === "long" ? "Bid" : "Ask"} replenishment`, pct(rep), rep > 0.5 ? 1 : -1, "observed", "book churn ±25bp", ts) as Evidence] : []),
    ],
    counter: [ev("Absorption can fail abruptly", "iceberg size is unobservable", -1, "inferred", "methodology", ts)],
    zone: side === "long" ? [lo, lo + 0.3 * a] : [hi - 0.3 * a, hi],
    trigger: side === "long" ? hi : lo,
    invalidation: side === "long" ? lo - 0.5 * a : hi + 0.5 * a,
    targets: targetsFor(side, ctx.price, ctx.liq),
    analogs: null,
    assumptions: ["Absorption is inferred from flow/price divergence and book churn; the identity of passive participants is unknown."],
  }];
}

function accumDistDetector(ctx: DetectorContext): Candidate[] {
  const out: Candidate[] = [];
  for (const tf of ["15m", "1h"] as Timeframe[]) {
    const A = ctx.assess[tf];
    const f = A?.features;
    if (!f || f.z.spotFlow === null || f.z.mom === null) continue;
    const ts = A!.ts;
    if (f.z.spotFlow > 1 && f.z.mom < 0.2) {
      out.push(mk("hidden_accumulation", "long", tf, squash((f.z.spotFlow - f.z.mom - 1) * 1.5), "Spot buyers are net aggressive while price is flat-to-down — consistent with accumulation into weakness (proxy).", f, ts));
    } else if (f.z.spotFlow < -1 && f.z.mom > -0.2) {
      out.push(mk("hidden_accumulation", "short", tf, squash((f.z.mom - f.z.spotFlow - 1) * 1.5), "Spot sellers are net aggressive while price is flat-to-up — consistent with distribution into strength (proxy).", f, ts));
    }
  }
  return out;
  function mk(d: DetectorId, side: Side, tf: Timeframe, strength: number, thesis: string, f: NonNullable<TfAssessment["features"]>, ts: number): Candidate {
    return {
      detector: d, side, tf, strength, completeness: f.z.perpFlow === null ? 0.7 : 1, thesis,
      evidence: [ev("Spot flow", `${pct(f.raw.spotFlow ?? 0)} (${(f.z.spotFlow ?? 0).toFixed(2)}σ)`, 1, "observed", `${tf} bars`, ts), ev("Momentum", `${(f.z.mom ?? 0).toFixed(2)}σ`, 1, "observed", `${tf} bars`, ts)],
      counter: [ev("Perp flow", `${pct(f.raw.perpFlow ?? 0)}`, ((f.z.perpFlow ?? 0) * (side === "long" ? 1 : -1)) < -1 ? -1 : 0, "observed", `${tf} bars`, ts), ev("Proxy only", "taker flow ≠ wallet intent", -1, "inferred", "methodology", ts)],
      zone: null, trigger: null, invalidation: null, targets: [], analogs: null,
      assumptions: ["'Hidden' accumulation is a proxy from aggressor-side spot volume vs price; no claim about who is buying."],
    };
  }
}

function squeezeDetector(ctx: DetectorContext): Candidate[] {
  const out: Candidate[] = [];
  for (const tf of ["15m", "1h", "4h"] as Timeframe[]) {
    const A = ctx.assess[tf];
    const f = A?.features;
    if (!f || f.z.funding === null) continue;
    const ts = A!.ts;
    const fz = f.z.funding, oz = f.z.oiChg ?? 0, mz = f.z.mom ?? 0, bz = f.z.basis ?? 0;
    // crowded longs: high funding/basis, rising OI, momentum stalling → long squeeze risk → SHORT hypothesis
    const longCrowd = (fz + bz) / 2;
    if (longCrowd > 1.2 && oz > 0 && mz < 0.8) {
      out.push(sq("long_squeeze", "short", tf, 0.9 * squash((longCrowd - 1.2) * 0.8 + Math.min(oz, 2) * 0.3), ts, f, "Longs are paying up (funding/basis elevated) while OI builds and price stalls — crowded longs are vulnerable to a cascade if support fails."));
    }
    if (longCrowd < -1.2 && oz > 0 && mz > -0.8) {
      out.push(sq("short_squeeze", "long", tf, 0.9 * squash((-longCrowd - 1.2) * 0.8 + Math.min(oz, 2) * 0.3), ts, f, "Shorts are paying (negative funding/basis) while OI builds and price holds — crowded shorts are vulnerable to a squeeze if resistance breaks."));
    }
  }
  return out;
  function sq(d: DetectorId, side: Side, tf: Timeframe, strength: number, ts: number, f: NonNullable<TfAssessment["features"]>, thesis: string): Candidate {
    const liqC = side === "long" ? ctx.liq?.nearestShortCluster : ctx.liq?.nearestLongCluster;
    return {
      detector: d, side, tf, strength, completeness: f.z.oiChg === null ? 0.6 : 1, thesis,
      evidence: [
        ev("Funding", `${((f.raw.funding ?? 0) * 1e4).toFixed(2)}bp/8h (${(f.z.funding ?? 0).toFixed(2)}σ)`, 1, "observed", `${tf} funding`, ts),
        ev("Basis", `${(f.raw.basis ?? 0).toFixed(1)}bp (${(f.z.basis ?? 0).toFixed(2)}σ)`, 1, "observed", `${tf} basis`, ts),
        ev("OI change", `${pct(f.raw.oiChg ?? 0)} (${(f.z.oiChg ?? 0).toFixed(2)}σ)`, 1, "observed", `${tf} OI`, ts),
        ...(liqC ? [ev("Nearest modeled cluster", `${liqC.price.toFixed(0)} (${pct(liqC.distPct)})`, 1, "modeled", "liq model", ts) as Evidence] : []),
      ],
      counter: [ev("Crowding can persist", "funding regimes last days in trends", -1, "inferred", "methodology", ts)],
      zone: null, trigger: null, invalidation: null,
      targets: targetsFor(side, ctx.price ?? 0, ctx.liq),
      analogs: null,
      assumptions: ["A setup, not a trigger: requires a catalyst/break to start the cascade."],
    };
  }
}

function failedBreakDetector(ctx: DetectorContext): Candidate[] {
  const bars = ctx.bars["5m"] ?? [];
  if (bars.length < 60 || !ctx.price) return [];
  const a = atr(bars, 14);
  if (!a) return [];
  const n = bars.length, look = 48;
  const prior = bars.slice(n - look - 3, n - 3);
  const lo = Math.min(...prior.map((b) => b.l)), hi = Math.max(...prior.map((b) => b.h));
  const recent = bars.slice(n - 3);
  const out: Candidate[] = [];
  const ts = bars[n - 1].t;
  const sweptLo = Math.min(...recent.map((b) => b.l));
  const sweptHi = Math.max(...recent.map((b) => b.h));
  const last = bars[n - 1].c;
  if (sweptLo < lo - 0.1 * a && last > lo) {
    const liqL = recent.reduce((s, b) => s + b.liqLong, 0);
    const fl = flowRatio(bars, n - 2, n - 1, "all");
    out.push({
      detector: "failed_breakdown", side: "long", tf: "5m", strength: clamp(0.45 + Math.min(0.25, (last - lo) / a * 0.2) + (fl !== null && fl > 0 ? 0.15 : 0) + (liqL > 0 ? 0.1 : 0), 0, 1), completeness: 1,
      thesis: "Price swept below the 4h range low (stops/liquidations taken) and closed back inside — sellers failed to hold the breakdown.",
      evidence: [ev("Range low", lo.toFixed(1), 0, "observed", "5m bars", ts), ev("Sweep depth", `${((lo - sweptLo) / a).toFixed(2)}×ATR`, 1, "observed", "5m bars", ts), ev("Reclaim", `close ${last.toFixed(1)} > ${lo.toFixed(1)}`, 1, "observed", "5m bars", ts), ...(fl !== null ? [ev("Flow on reclaim", pct(fl), fl > 0 ? 1 : -1, "observed", "5m bars", ts) as Evidence] : [])],
      counter: fl !== null && fl < -0.05 ? [ev("Flow still negative", pct(fl), -1, "observed", "5m bars", ts)] : [],
      zone: [lo - 0.2 * a, lo + 0.2 * a], trigger: lo, invalidation: sweptLo - 0.2 * a,
      targets: targetsFor("long", last, ctx.liq, [{ price: (lo + hi) / 2, why: "range midpoint" }, { price: hi, why: "range high" }]),
      analogs: null, assumptions: ["Range = prior 48×5m bars."],
    });
  }
  if (sweptHi > hi + 0.1 * a && last < hi) {
    const fl = flowRatio(bars, n - 2, n - 1, "all");
    out.push({
      detector: "failed_breakout", side: "short", tf: "5m", strength: clamp(0.45 + Math.min(0.25, (hi - last) / a * 0.2) + (fl !== null && fl < 0 ? 0.15 : 0), 0, 1), completeness: 1,
      thesis: "Price swept above the 4h range high and closed back inside — buyers failed to hold the breakout.",
      evidence: [ev("Range high", hi.toFixed(1), 0, "observed", "5m bars", ts), ev("Sweep depth", `${((sweptHi - hi) / a).toFixed(2)}×ATR`, 1, "observed", "5m bars", ts), ev("Rejection", `close ${last.toFixed(1)} < ${hi.toFixed(1)}`, 1, "observed", "5m bars", ts)],
      counter: fl !== null && fl > 0.05 ? [ev("Flow still positive", pct(fl), -1, "observed", "5m bars", ts)] : [],
      zone: [hi - 0.2 * a, hi + 0.2 * a], trigger: hi, invalidation: sweptHi + 0.2 * a,
      targets: targetsFor("short", last, ctx.liq, [{ price: (lo + hi) / 2, why: "range midpoint" }, { price: lo, why: "range low" }]),
      analogs: null, assumptions: ["Range = prior 48×5m bars."],
    });
  }
  return out;
}

function divergenceDetectors(ctx: DetectorContext): Candidate[] {
  const out: Candidate[] = [];
  const A = ctx.assess["15m"];
  const f = A?.features;
  if (!f || f.z.mom === null) return out;
  const ts = A!.ts;
  const m = f.z.mom;
  // Spot–perp: futures-led move without spot
  if (f.z.perpFlow !== null && f.z.spotFlow !== null) {
    const gap = f.z.perpFlow - f.z.spotFlow;
    if (m > 0.8 && gap > 1.5 && f.z.spotFlow < 0.3) out.push(dv("spot_perp_divergence", "short", squash((gap - 1.5) * 1.5), "Rally is perp-led: futures buyers are aggressive while spot is not participating — leverage-driven moves without spot demand are fragile.", [["Perp flow", f.z.perpFlow], ["Spot flow", f.z.spotFlow], ["Momentum", m]]));
    if (m < -0.8 && gap < -1.5 && f.z.spotFlow > -0.3) out.push(dv("spot_perp_divergence", "long", squash((-gap - 1.5) * 1.5), "Decline is perp-led: futures sellers are aggressive while spot is not selling — leverage-driven drops without spot supply can retrace.", [["Perp flow", f.z.perpFlow], ["Spot flow", f.z.spotFlow], ["Momentum", m]]));
  }
  // OI divergence
  if (f.z.oiChg !== null) {
    if (m > 1 && f.z.oiChg < -1) out.push(dv("oi_divergence", "short", squash((m - f.z.oiChg - 2) * 0.8) * 0.8, "Price rising while OI falls — rally driven by short covering rather than new longs; often loses momentum once covering ends.", [["Momentum", m], ["OI change", f.z.oiChg]]));
    if (m < -1 && f.z.oiChg < -1) out.push(dv("oi_divergence", "long", squash((-m - f.z.oiChg - 2) * 0.8) * 0.8, "Price falling while OI falls — longs closing / liquidating rather than new shorts; deleveraging declines tend to exhaust.", [["Momentum", m], ["OI change", f.z.oiChg]]));
  }
  // Funding divergence
  if (f.z.funding !== null) {
    if (m > 1 && f.z.funding < -0.8) out.push(dv("funding_divergence", "long", squash((m - f.z.funding - 1.8)), "Price rising while funding is falling/negative — shorts are paying into strength (squeeze fuel); rally not driven by levered longs.", [["Momentum", m], ["Funding", f.z.funding]]));
    if (m < -1 && f.z.funding > 0.8) out.push(dv("funding_divergence", "short", squash((f.z.funding - m - 1.8)), "Price falling while funding stays elevated — longs still paying to hold into weakness; further long liquidation risk.", [["Momentum", m], ["Funding", f.z.funding]]));
  }
  return out;
  function dv(d: DetectorId, side: Side, strength: number, thesis: string, items: [string, number][]): Candidate {
    return {
      detector: d, side, tf: "15m", strength, completeness: 1, thesis,
      evidence: items.map(([l, z]) => ev(l, `${z.toFixed(2)}σ`, 1, "observed", "15m features", ts)),
      counter: [ev("Divergences can persist in trends", "confirm with structure", -1, "inferred", "methodology", ts)],
      zone: null, trigger: null, invalidation: null, targets: targetsFor(side, ctx.price ?? 0, ctx.liq), analogs: null,
      assumptions: ["Joint price/OI/funding interpretation; no single metric is treated as directional."],
    };
  }
}

function dislocationDetector(ctx: DetectorContext): Candidate[] {
  const rows = ctx.venues.filter((v) => v.dislocationBps !== null && v.state === "live");
  if (rows.length < 3 || !ctx.price) return [];
  const abs = rows.map((r) => Math.abs(r.dislocationBps!)).sort((a, b) => a - b);
  const med = abs[Math.floor(abs.length / 2)];
  const thr = Math.max(4, med * 4);
  const out: Candidate[] = [];
  for (const r of rows) {
    if (Math.abs(r.dislocationBps!) < thr) continue;
    const isLeader = ctx.leadLag?.leader === r.key;
    // A laggard's dislocation says nothing about market direction (it is venue-specific), so it emits no hypothesis.
    if (!isLeader) continue;
    const side: Side = r.dislocationBps! > 0 ? "long" : "short";
    const ts = ctx.now;
    out.push({
      detector: "cross_venue_dislocation", side, tf: "1m", strength: clamp((Math.abs(r.dislocationBps!) / thr - 1) * 0.4 + 0.3, 0, 0.85), completeness: 1,
      thesis: isLeader
        ? `${r.venue} ${r.market} — the current lead venue — is trading ${r.dislocationBps! > 0 ? "above" : "below"} the cross-venue median; laggards have historically tended to follow the leader.`
        : `${r.venue} ${r.market} is dislocated from the cross-venue median; without lead status this more often mean-reverts (venue-specific flow).`,
      evidence: [ev(`${r.venue} ${r.market} dislocation`, `${r.dislocationBps!.toFixed(1)}bp (thr ${thr.toFixed(1)})`, 1, "observed", "venue mids", ts), ev("Lead-lag status", isLeader ? "leader" : "not leader", isLeader ? 1 : -1, "modeled", "lead-lag xcorr", ts)],
      counter: [ev("Dislocations close fast", "edge decays in seconds; fees/latency dominate", -1, "inferred", "methodology", ts)],
      zone: null, trigger: null, invalidation: null, targets: [], analogs: null,
      assumptions: ["Median of live venue mids is the reference; USD vs USDT quote differences are not adjusted (stablecoin basis)."],
    });
  }
  return out.slice(0, 2);
}

function vacuumDetector(ctx: DetectorContext): Candidate[] {
  const h = ctx.depthHist;
  if (h.length < 60 || !ctx.price) return [];
  const last = h[h.length - 1];
  const bids = h.map((x) => x.bid100), asks = h.map((x) => x.ask100);
  const zb = robustZ(last.bid100, bids.slice(0, -1), 30), za = robustZ(last.ask100, asks.slice(0, -1), 30);
  const out: Candidate[] = [];
  const ts = ctx.now;
  if (za !== null && za < -2 && (zb ?? 0) > za + 1) out.push(vc("long", za, last.ask100));
  if (zb !== null && zb < -2 && (za ?? 0) > zb + 1) out.push(vc("short", zb, last.bid100));
  return out;
  function vc(side: Side, z: number, usd: number): Candidate {
    return {
      detector: "liquidity_vacuum", side, tf: "1m", strength: squash((-z - 2) * 1.5), completeness: 1,
      thesis: side === "long" ? "Offers within 100bp have thinned sharply versus their recent norm — upside moves face less resting supply." : "Bids within 100bp have thinned sharply versus their recent norm — downside moves face less resting demand.",
      evidence: [ev(`${side === "long" ? "Ask" : "Bid"} depth ≤100bp`, `$${(usd / 1e6).toFixed(1)}M (${z.toFixed(2)}σ)`, 1, "observed", "aggregated books", ts)],
      counter: [ev("Thin books cut both ways", "fragility ≠ direction; liquidity can refill instantly", -1, "inferred", "methodology", ts)],
      zone: null, trigger: null, invalidation: null, targets: targetsFor(side, ctx.price!, ctx.liq), analogs: null,
      assumptions: ["Aggregated across valid live books only."],
    };
  }
}

const TWO_B_TFS: Timeframe[] = ["15m", "1h", "4h"];

function twoBPriceDetector(ctx: DetectorContext): Candidate[] {
  const out: Candidate[] = [];
  for (const tf of TWO_B_TFS) {
    const bars = ctx.bars[tf] ?? [];
    if (bars.length < 60) continue;
    const sigs = detect2B(bars.slice(-300));
    const live = sigs.filter((x) => x.state === "confirmed" && x.barsAgo <= 3).at(-1);
    if (!live) continue;
    const top = live.kind === "top";
    const side: Side = top ? "short" : "long";
    const ts = bars[bars.length - 1].t;
    const pen = Math.abs(live.extreme - live.trigger);
    const a = atr(bars, 14) ?? pen;
    out.push({
      detector: "price_2b", side, tf, strength: clamp(0.4 + Math.min(0.25, pen / a * 0.15) + (live.barsAgo === 0 ? 0.1 : 0), 0, 0.8), completeness: 1,
      thesis: top
        ? `2B top: price pushed above the prior ${tf} swing high (${live.trigger.toFixed(1)}) and closed back below it — the breakout failed to attract follow-through.`
        : `2B bottom: price pushed below the prior ${tf} swing low (${live.trigger.toFixed(1)}) and closed back above it — the breakdown failed to attract follow-through.`,
      evidence: [
        ev("Prior swing " + (top ? "high" : "low"), `${live.trigger.toFixed(1)} @ ${new Date(live.pivot.t).toISOString().slice(5, 16)}`, 0, "observed", `${tf} pivots (k=3)`, ts),
        ev("False-break extreme", `${live.extreme.toFixed(1)} (${(pen / a).toFixed(2)}×ATR beyond)`, 1, "observed", `${tf} bars`, ts),
        ev("Failure close", `${live.barsAgo} bar(s) ago`, 1, "observed", `${tf} bars`, ts),
      ],
      counter: [ev("2B is a pattern, not proof", "many 2Bs are followed by a second, successful breakout", -1, "inferred", "methodology", ts)],
      zone: top ? [live.trigger, live.extreme] : [live.extreme, live.trigger], trigger: live.trigger, invalidation: live.invalidation,
      targets: targetsFor(side, bars[bars.length - 1].c, ctx.liq),
      analogs: null,
      assumptions: ["Sperandeo 2B: break of the last confirmed swing pivot (fractal k=3) and close back inside within 3 bars.", "Invalidation = false-break extreme ± 0.1×ATR."],
    });
  }
  return out;
}

function vix2BDetector(ctx: DetectorContext): Candidate[] {
  const out: Candidate[] = [];
  const price = ctx.price;
  if (!price) return out;
  const sources: { tf: Timeframe; series: { t: number; h: number; l: number; c: number }[]; name: string; prov: "observed" | "modeled" }[] = [];
  if (ctx.vix?.status === "ok") sources.push({ tf: "1d", series: ctx.vix.bars.slice(-400), name: "CBOE VIX (equity fear gauge, cross-asset)", prov: "observed" });
  if (ctx.dvol?.status === "ok") {
    sources.push({ tf: "1h", series: ctx.dvol.h1, name: "DVOL (Deribit implied vol)", prov: "observed" });
    sources.push({ tf: "4h", series: aggregateVol(ctx.dvol.h1, 4), name: "DVOL (Deribit implied vol)", prov: "observed" });
  } else {
    for (const tf of ["1h", "4h"] as Timeframe[]) {
      const bars = ctx.bars[tf] ?? [];
      if (bars.length >= 80) sources.push({ tf, series: williamsVixFix(bars.slice(-300)), name: "Williams VIX Fix (price-derived)", prov: "modeled" });
    }
  }
  for (const src of sources) {
    const sigs: TwoB[] = detect2B(src.series);
    const live = sigs.filter((x) => x.kind === "top" && x.state === "confirmed" && x.barsAgo <= 2).at(-1);
    if (!live) continue;
    const ts = src.series[src.series.length - 1].t;
    const cross = src.name.startsWith("CBOE");
    const st = src.name.startsWith("Williams") ? wvfState(src.series as never) : null;
    out.push({
      detector: "vix_2b", side: "long", tf: src.tf, strength: 0.55, completeness: src.prov === "observed" ? 1 : 0.75,
      thesis: `VIX 2B top on ${src.name}: volatility spiked above its prior swing high (${live.trigger.toFixed(1)}) and immediately fell back — the fear spike failed to extend. Historically this tends to mark relief rather than further panic.`,
      evidence: [
        ev(`${src.tf} vol swing high`, live.trigger.toFixed(2), 0, src.prov, src.name, ts),
        ev("Spike extreme", live.extreme.toFixed(2), 1, src.prov, src.name, ts),
        ev("Back below swing high", `${live.barsAgo} bar(s) ago`, 1, src.prov, src.name, ts),
        ...(st ? [ev("WVF percentile (500 bars)", `${Math.round(st.percentile * 100)}%`, 0, "modeled", "WVF", ts) as Evidence] : []),
      ],
      counter: [ev("Vol can re-spike", "a second higher vol high invalidates the 2B", -1, "inferred", "methodology", ts), cross ? ev("Cross-asset link varies", "BTC–equity correlation is regime-dependent; see the event study in VIX 2B · Gann", -1, "inferred", "methodology", ts) : ev("Equity-VIX heuristic", "transfer to crypto vol is unvalidated", -1, "inferred", "methodology", ts)],
      zone: null, trigger: null, invalidation: null,
      targets: targetsFor("long", price, ctx.liq),
      analogs: null,
      assumptions: [`Volatility 2B invalidates if ${src.name} exceeds ${live.invalidation.toFixed(2)}.`, cross ? "CBOE VIX daily bars; signal known after the US cash close." : src.prov === "modeled" ? "DVOL unavailable — using the Williams VIX Fix computed from price bars." : "DVOL is Deribit's 30-day implied volatility index."],
    });
  }
  return out;
}

export function detectorStatus(ctx: DetectorContext): DetectorStatus[] {
  const hasBook = ctx.venues.some((v) => v.state === "live" && v.levels > 0);
  return [
    { id: "liquidation_exhaustion", available: (ctx.bars["5m"]?.length ?? 0) > 80 || ctx.bars1m.length > 80 },
    { id: "passive_absorption", available: ctx.bars1m.length >= 60, reason: "needs ≥60 live 1m bars" },
    { id: "hidden_accumulation", available: !!ctx.assess["15m"]?.features?.z.spotFlow },
    { id: "short_squeeze", available: ctx.assess["1h"]?.features?.z.funding != null, reason: "needs funding history" },
    { id: "long_squeeze", available: ctx.assess["1h"]?.features?.z.funding != null, reason: "needs funding history" },
    { id: "failed_breakdown", available: (ctx.bars["5m"]?.length ?? 0) >= 60 },
    { id: "failed_breakout", available: (ctx.bars["5m"]?.length ?? 0) >= 60 },
    { id: "funding_divergence", available: ctx.assess["15m"]?.features?.z.funding != null },
    { id: "oi_divergence", available: ctx.assess["15m"]?.features?.z.oiChg != null },
    { id: "spot_perp_divergence", available: ctx.assess["15m"]?.features?.z.perpFlow != null },
    { id: "cross_venue_dislocation", available: ctx.venues.filter((v) => v.state === "live").length >= 3, reason: "needs ≥3 live venues" },
    { id: "options_hedging_event", available: ctx.optionsAvailable, reason: "see Options panel (Deribit chain); engine hook pending validation" },
    { id: "macro_shock", available: ctx.macroAvailable, reason: "no licensed macro/news feed connected" },
    { id: "liquidity_vacuum", available: hasBook && ctx.depthHist.length >= 60, reason: "needs ≥60s of live books" },
    { id: "price_2b", available: (ctx.bars["15m"]?.length ?? 0) >= 60 },
    { id: "vix_2b", available: ctx.vix?.status === "ok" || ctx.dvol?.status === "ok" || (ctx.bars["1h"]?.length ?? 0) >= 80, reason: ctx.dvol?.status === "ok" ? undefined : "DVOL unavailable → Williams VIX Fix fallback" },
  ];
}

export function runDetectors(ctx: DetectorContext): Candidate[] {
  return [
    ...exhaustionDetector(ctx),
    ...absorptionDetector(ctx),
    ...accumDistDetector(ctx),
    ...squeezeDetector(ctx),
    ...failedBreakDetector(ctx),
    ...divergenceDetectors(ctx),
    ...dislocationDetector(ctx),
    ...vacuumDetector(ctx),
    ...twoBPriceDetector(ctx),
    ...vix2BDetector(ctx),
  ];
}

export interface AuditEntry {
  ts: number;
  key: string;
  from: Lifecycle | null;
  to: Lifecycle;
  price: number | null;
  strength: number;
  digest: string;
}

/** Lifecycle manager: detected → developing → actionable; invalidated / expired. Every transition is audited. */
export class OpportunityBook {
  private live = new Map<string, Opportunity>();
  recent: Opportunity[] = [];
  audit: AuditEntry[] = [];

  update(cands: Candidate[], now: number, price: number | null, ttlMs = 90_000): Opportunity[] {
    const seen = new Set<string>();
    for (const c of cands) {
      const key = `${c.detector}:${c.side}:${c.tf}`;
      seen.add(key);
      const prev = this.live.get(key);
      const state: Lifecycle = c.state ?? (c.strength >= 0.65 && c.trigger !== null ? "developing" : "detected");
      const o: Opportunity = { ...c, key, state, firstSeen: prev?.firstSeen ?? now, updated: now, firstPrice: prev?.firstPrice ?? price ?? 0 };
      if (!prev || prev.state !== o.state) this.log(now, key, prev?.state ?? null, o.state, price, o);
      if (o.state === "invalidated") { this.retire(o); continue; }
      this.live.set(key, o);
    }
    for (const [key, o] of this.live) {
      if (seen.has(key)) continue;
      // disappeared: check invalidation vs price, else expire after TTL
      const inval = o.invalidation !== null && price !== null && ((o.side === "long" && price < o.invalidation) || (o.side === "short" && price > o.invalidation));
      if (inval) { this.log(now, key, o.state, "invalidated", price, o); this.retire({ ...o, state: "invalidated", updated: now }); }
      else if (now - o.updated > ttlMs) { this.log(now, key, o.state, "expired", price, o); this.retire({ ...o, state: "expired", updated: now }); }
    }
    return this.list();
  }
  list() {
    const rank: Record<Lifecycle, number> = { actionable: 3, developing: 2, detected: 1, invalidated: 0, expired: 0 };
    return [...this.live.values()].sort((a, b) => rank[b.state] - rank[a.state] || b.strength - a.strength);
  }
  private retire(o: Opportunity) {
    this.live.delete(o.key);
    this.recent.unshift(o);
    if (this.recent.length > 30) this.recent.pop();
  }
  private log(ts: number, key: string, from: Lifecycle | null, to: Lifecycle, price: number | null, o: Opportunity) {
    const digest = hash(JSON.stringify([o.detector, o.side, o.tf, o.strength.toFixed(4), o.evidence.map((e) => e.value), o.zone, o.trigger, o.invalidation]));
    this.audit.unshift({ ts, key, from, to, price, strength: o.strength, digest });
    if (this.audit.length > 200) this.audit.pop();
  }
}

/** FNV-1a 32-bit — evidence digest for the audit trail. */
export function hash(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function refreshAnalogs(bars5m: Bar[], cache: Map<string, AnalogStats>) {
  if (bars5m.length < 200) return;
  cache.set("exh:long", historicalAnalogs(bars5m, "long"));
  cache.set("exh:short", historicalAnalogs(bars5m, "short"));
}

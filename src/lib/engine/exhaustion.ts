import type { Evidence, Side } from "../core/types";
import { clamp, linreg, robustZ, squash } from "../core/stats";
import type { Bar } from "./bars";
import { atr, perpDelta, spotDelta } from "./bars";

/**
 * LIQUIDITY EXHAUSTION & REVERSAL ENGINE (primary differentiator)
 *
 * Downside exhaustion → LONG hypothesis. All conditions are measured, not asserted:
 *   C1 Aggressive selling persists        net taker flow over recent window R is strongly negative
 *   C2 Downside price impact weakens      λ_recent (bps per unit normalized sell flow) < λ_prior
 *   C3 OI contracts                       ΔOI over R < 0 (positions closing / liquidated, not fresh shorts)
 *   C4 Bids replenish (live book only)    near-touch bid additions outpace removals; bid imbalance rising
 *   C5 Spot selling subsides              spot flow ratio in the latest third of R > earlier part of R
 *   C6 Forced selling exhausting          long liquidations peaked and are decaying
 * Upside exhaustion → SHORT hypothesis is the exact mirror (aggressive buying absorbed near highs).
 *
 * Output is an EVIDENCE STRENGTH, not a probability. Missing inputs (e.g. no live
 * book, no OI) reduce completeness and are listed — never filled in.
 */

export interface BookPressure {
  /** replenishment ratio near touch over the last minute: adds / (adds + removes) per side, null if no book */
  bidReplenish: number | null;
  askReplenish: number | null;
  /** change in 25bp depth imbalance over the last ~2 minutes ([-2,2]); positive = bids strengthening */
  imbalanceTrend: number | null;
}

export interface ExhaustionCondition {
  id: string;
  label: string;
  met: number | null; // membership in [0,1], null = unavailable
  detail: string;
  weight: number;
}

export type Lifecycle = "detected" | "developing" | "actionable" | "invalidated" | "expired";

export interface ExhaustionSignal {
  side: Side; // hypothesis direction
  movement: "downside_exhaustion" | "upside_exhaustion";
  strength: number; // [0,1] weighted evidence strength
  completeness: number; // share of condition weight that was measurable
  conditions: ExhaustionCondition[];
  counter: Evidence[];
  extreme: number; // window low (long) or high (short)
  zone: [number, number];
  trigger: number; // reclaim level
  invalidation: number;
  atr: number;
  state: Lifecycle;
  ts: number;
}

export interface ExhaustionParams {
  recent: number; // bars in recent window R
  prior: number; // bars in prior comparison window
  invalidAtr: number;
}

export const DEFAULT_EXHAUSTION: ExhaustionParams = { recent: 15, prior: 30, invalidAtr: 0.6 };

function lambda(bars: Bar[], from: number, to: number): { slope: number; flow: number } | null {
  const xs: number[] = [], ys: number[] = [];
  let flow = 0;
  for (let j = Math.max(1, from); j <= to; j++) {
    const b = bars[j];
    const d = (spotDelta(b) ?? 0) + (perpDelta(b) ?? 0);
    const tv = (b.spotBuy ?? 0) + (b.spotSell ?? 0) + (b.perpBuy ?? 0) + (b.perpSell ?? 0);
    if (tv <= 0) continue;
    xs.push(d / tv);
    ys.push(Math.log(b.c / bars[j - 1].c) * 10_000);
    flow += d;
  }
  const lr = linreg(xs, ys);
  return lr ? { slope: lr.slope, flow } : null;
}

/** Bps of adverse price move per unit of aggressive volume, signed so larger = more impact in `dir`. */
function directionalImpact(bars: Bar[], from: number, to: number, dir: 1 | -1): number | null {
  let move = 0, vol = 0;
  for (let j = Math.max(1, from); j <= to; j++) {
    const b = bars[j];
    const d = (spotDelta(b) ?? 0) + (perpDelta(b) ?? 0);
    if (Math.sign(d) !== dir) continue;
    move += Math.log(b.c / bars[j - 1].c) * 10_000 * dir;
    vol += Math.abs(d);
  }
  return vol > 0 ? move / vol : null;
}

export function evaluateExhaustion(bars: Bar[], side: Side, book: BookPressure | null, p: ExhaustionParams = DEFAULT_EXHAUSTION): ExhaustionSignal | null {
  const n = bars.length;
  const { recent: R, prior: P } = p;
  if (n < R + P + 20) return null;
  const i = n - 1;
  const a = atr(bars, 14);
  if (!a) return null;
  const dir: 1 | -1 = side === "long" ? -1 : 1; // the exhausting aggressor direction (sellers for long hypothesis)
  const conds: ExhaustionCondition[] = [];
  const counter: Evidence[] = [];
  const ts = bars[i].t;

  // C1 — aggressive flow persists in `dir`
  const flowSeries: number[] = [];
  for (let j = Math.max(0, n - 300); j < n; j++) {
    const b = bars[j];
    const tv = (b.spotBuy ?? 0) + (b.spotSell ?? 0) + (b.perpBuy ?? 0) + (b.perpSell ?? 0);
    const d = (spotDelta(b) ?? NaN) + (perpDelta(b) ?? NaN);
    flowSeries.push(tv > 0 && Number.isFinite(d) ? d / tv : NaN);
  }
  const recentFlow = mean(flowSeries.slice(-R));
  const rollMeans: number[] = [];
  for (let k = R; k < flowSeries.length - R; k += 3) rollMeans.push(mean(flowSeries.slice(k - R, k)) ?? NaN);
  const zFlow = recentFlow === null ? null : robustZ(recentFlow, rollMeans.filter(Number.isFinite), 15);
  conds.push({ id: "C1", label: dir < 0 ? "Aggressive selling persists" : "Aggressive buying persists", met: zFlow === null ? null : squash((zFlow * dir - 0.8) * 2.5), detail: zFlow === null ? "flow unavailable" : `recent net flow ${(recentFlow! * 100).toFixed(1)}% of volume (${zFlow.toFixed(2)}σ)`, weight: 0.22 });

  // C2 — impact per unit of aggressive flow weakens
  const impRecent = directionalImpact(bars, i - R + 1, i, dir);
  const impPrior = directionalImpact(bars, i - R - P + 1, i - R, dir);
  let c2: number | null = null;
  let c2d = "insufficient aggressive bars";
  if (impRecent !== null && impPrior !== null && impPrior > 0) {
    const ratio = impRecent / impPrior;
    c2 = squash((0.75 - ratio) * 4);
    c2d = `impact ${impRecent.toFixed(1)} vs prior ${impPrior.toFixed(1)} bp/unit (ratio ${ratio.toFixed(2)})`;
    if (ratio > 1.2) counter.push({ label: "Impact expanding, not weakening", value: `×${ratio.toFixed(2)}`, provenance: "modeled", stance: -1, source: "exhaustion.C2", ts });
  } else if (impRecent !== null && impPrior !== null && impPrior <= 0) {
    c2 = 0.5;
    c2d = "prior window had no net adverse impact";
  }
  conds.push({ id: "C2", label: dir < 0 ? "Downside impact weakens" : "Upside impact weakens", met: c2, detail: c2d, weight: 0.24 });

  // C3 — OI contracts over the recent window
  const oi0 = bars[i - R].oi, oi1 = bars[i].oi;
  let c3: number | null = null;
  let c3d = "OI unavailable";
  if (oi0 && oi1) {
    const ch = Math.log(oi1 / oi0);
    const hist: number[] = [];
    for (let k = Math.max(R, n - 300); k < n - R; k += 2) { const x0 = bars[k - R].oi, x1 = bars[k].oi; if (x0 && x1) hist.push(Math.log(x1 / x0)); }
    const z = robustZ(ch, hist, 15);
    c3 = z === null ? squash(-ch * 400) : squash((-z - 0.5) * 2.5);
    c3d = `ΔOI ${(ch * 100).toFixed(2)}%${z !== null ? ` (${z.toFixed(2)}σ)` : ""}`;
    if (ch > 0.002) counter.push({ label: dir < 0 ? "OI rising into the decline (fresh shorts?)" : "OI rising into the rally (fresh longs?)", value: `${(ch * 100).toFixed(2)}%`, provenance: "inferred", stance: -1, source: "exhaustion.C3", ts });
  }
  conds.push({ id: "C3", label: "Open interest contracts", met: c3, detail: c3d, weight: 0.18 });

  // C4 — passive liquidity replenishes on the absorbing side (live book only)
  let c4: number | null = null;
  let c4d = "no live order book (historical bars only)";
  if (book) {
    const rep = dir < 0 ? book.bidReplenish : book.askReplenish;
    const trend = book.imbalanceTrend === null ? null : book.imbalanceTrend * -dir;
    const parts = [rep === null ? null : squash((rep - 0.52) * 12), trend === null ? null : squash(trend * 6)].filter((x): x is number => x !== null);
    if (parts.length) {
      c4 = parts.reduce((x, y) => x + y, 0) / parts.length;
      c4d = `${dir < 0 ? "bid" : "ask"} replenish ${rep === null ? "n/a" : (rep * 100).toFixed(0) + "%"}, imbalance trend ${trend === null ? "n/a" : trend.toFixed(2)}`;
      if (rep !== null && rep < 0.4) counter.push({ label: `${dir < 0 ? "Bids" : "Asks"} being pulled`, value: `${(rep * 100).toFixed(0)}% adds`, provenance: "observed", stance: -1, source: "book churn", ts });
    }
  }
  conds.push({ id: "C4", label: dir < 0 ? "Bids replenish" : "Asks replenish", met: c4, detail: c4d, weight: 0.14 });

  // C5 — spot aggression subsides within the window
  const third = Math.max(3, Math.floor(R / 3));
  const spotRatio = (from: number, to: number) => {
    let d = 0, v = 0, ok = false;
    for (let j = from; j <= to; j++) { const s = spotDelta(bars[j]); if (s === null) continue; ok = true; d += s; v += (bars[j].spotBuy ?? 0) + (bars[j].spotSell ?? 0); }
    return ok && v > 0 ? d / v : null;
  };
  const early = spotRatio(i - R + 1, i - third), late = spotRatio(i - third + 1, i);
  let c5: number | null = null;
  let c5d = "spot flow unavailable";
  if (early !== null && late !== null) {
    const easing = (late - early) * -dir; // positive = spot aggression in dir easing
    c5 = squash((easing - 0.03) * 25);
    c5d = `spot flow ${(early * 100).toFixed(1)}% → ${(late * 100).toFixed(1)}%`;
    if (easing < -0.08) counter.push({ label: dir < 0 ? "Spot selling accelerating" : "Spot buying accelerating", value: `${(late * 100).toFixed(1)}%`, provenance: "observed", stance: -1, source: "exhaustion.C5", ts });
  }
  conds.push({ id: "C5", label: dir < 0 ? "Spot selling subsides" : "Spot buying subsides", met: c5, detail: c5d, weight: 0.14 });

  // C6 — forced flow exhausting: liquidations in dir peaked and decaying
  const liq = (b: Bar) => (dir < 0 ? b.liqLong : b.liqShort);
  let peak = 0, peakIdx = -1, total = 0;
  for (let j = i - R + 1; j <= i; j++) { total += liq(bars[j]); if (liq(bars[j]) > peak) { peak = liq(bars[j]); peakIdx = j; } }
  let c6: number | null = null;
  let c6d = "no liquidations observed in window";
  if (total > 0 && peakIdx >= 0) {
    const after = bars.slice(peakIdx + 1, i + 1).map(liq);
    const decay = after.length ? 1 - Math.max(...after) / peak : 0;
    c6 = clamp(decay * (after.length >= 2 ? 1 : 0.5), 0, 1);
    c6d = `peak ${peak.toFixed(2)} ${i - peakIdx} bars ago, decay ${(decay * 100).toFixed(0)}%`;
  }
  conds.push({ id: "C6", label: dir < 0 ? "Long liquidations exhausting" : "Short liquidations exhausting", met: c6, detail: c6d, weight: 0.08 });

  // Higher-level context counter-evidence: strong momentum in the window
  let ext = dir < 0 ? Infinity : -Infinity;
  for (let j = i - R + 1; j <= i; j++) ext = dir < 0 ? Math.min(ext, bars[j].l) : Math.max(ext, bars[j].h);
  const last = bars[i].c;
  const moveIntoExtreme = Math.log(bars[i - R].c / ext) * -dir; // positive when price moved in dir over window
  if (moveIntoExtreme * 10_000 < a / last * 10_000 * 0.8) counter.push({ label: "No meaningful move to exhaust", value: `${(moveIntoExtreme * 10_000).toFixed(0)}bp`, provenance: "observed", stance: -1, source: "window move", ts });

  // Aggregate
  let wSum = 0, wAvail = 0, s = 0;
  for (const c of conds) { wSum += c.weight; if (c.met !== null) { wAvail += c.weight; s += c.met * c.weight; } }
  const completeness = wAvail / wSum;
  const strength = wAvail > 0 ? (s / wAvail) * Math.sqrt(completeness) * (1 - Math.min(0.5, counter.length * 0.1)) : 0;

  const zone: [number, number] = dir < 0 ? [ext, ext + 0.5 * a] : [ext - 0.5 * a, ext];
  // Trigger: reclaim of the window's mid-range (structure) — conventional confirmation would be far later
  let hiW = -Infinity, loW = Infinity;
  for (let j = i - R + 1; j <= i; j++) { hiW = Math.max(hiW, bars[j].h); loW = Math.min(loW, bars[j].l); }
  const trigger = dir < 0 ? Math.min(hiW, ext + 0.8 * a) : Math.max(loW, ext - 0.8 * a);
  const invalidation = dir < 0 ? ext - p.invalidAtr * a : ext + p.invalidAtr * a;

  const metCount = conds.filter((c) => (c.met ?? 0) >= 0.6).length;
  const c1 = (conds[0].met ?? 0) >= 0.5, c2ok = (conds[1].met ?? 0) >= 0.5;
  let state: Lifecycle = "detected";
  if ((dir < 0 && last < invalidation) || (dir > 0 && last > invalidation)) state = "invalidated";
  else if (c1 && c2ok && metCount >= 4 && ((dir < 0 && last >= trigger) || (dir > 0 && last <= trigger))) state = "actionable";
  else if (c1 && c2ok && metCount >= 3) state = "developing";

  return { side, movement: dir < 0 ? "downside_exhaustion" : "upside_exhaustion", strength, completeness, conditions: conds, counter, extreme: ext, zone, trigger, invalidation, atr: a, state, ts };
}

function mean(xs: number[]): number | null {
  const v = xs.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

/**
 * Historical analogs: replay the bar-only version of the detector across history
 * (no book input, strictly past data at each step) and report forward outcomes.
 * In-sample, descriptive only — shown with n and labeled as such.
 */
export interface AnalogStats {
  n: number;
  horizonBars: number;
  medianFwdBps: number | null;
  hitRate: number | null; // fraction moving in hypothesis direction
  medianMaeBps: number | null; // adverse excursion before horizon
  invalidatedShare: number | null;
  note: string;
}

export function historicalAnalogs(bars: Bar[], side: Side, horizon = 12, threshold = 0.55, p: ExhaustionParams = DEFAULT_EXHAUSTION): AnalogStats {
  const fwd: number[] = [], mae: number[] = [];
  let inval = 0;
  const minStart = p.recent + p.prior + 20;
  let lastHit = -Infinity;
  for (let k = minStart; k < bars.length - horizon - 1; k++) {
    if (k - lastHit < horizon) continue; // non-overlapping
    const sig = evaluateExhaustion(bars.slice(Math.max(0, k - 320), k + 1), side, null, p);
    if (!sig || sig.strength < threshold || sig.state === "invalidated") continue;
    lastHit = k;
    const entry = bars[k].c;
    const dir = side === "long" ? 1 : -1;
    let worst = 0, invHit = false;
    for (let j = k + 1; j <= k + horizon; j++) {
      const adverse = side === "long" ? (bars[j].l - entry) / entry : (entry - bars[j].h) / entry;
      worst = Math.min(worst, adverse);
      if ((side === "long" && bars[j].l < sig.invalidation) || (side === "short" && bars[j].h > sig.invalidation)) invHit = true;
    }
    fwd.push(((bars[k + horizon].c - entry) / entry) * 10_000 * dir);
    mae.push(worst * 10_000);
    if (invHit) inval++;
  }
  const med = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  return {
    n: fwd.length,
    horizonBars: horizon,
    medianFwdBps: med(fwd),
    hitRate: fwd.length ? fwd.filter((x) => x > 0).length / fwd.length : null,
    medianMaeBps: med(mae),
    invalidatedShare: fwd.length ? inval / fwd.length : null,
    note: "In-sample, bar-only replay (no order-book condition), before costs. Descriptive, not predictive.",
  };
}

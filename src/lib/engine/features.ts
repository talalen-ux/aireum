import type { FeatureSpec } from "../core/types";
import { linreg, robustZ } from "../core/stats";
import type { Bar } from "./bars";
import { perpDelta, spotDelta } from "./bars";

/**
 * Feature registry. Every feature is defined mathematically, computed strictly from
 * bars at or before index i (no look-ahead), and normalized with a robust z-score
 * (median / 1.4826·MAD) against its own trailing history on the same timeframe.
 * W = regime window (bars), default 12.
 */
export const FEATURES: FeatureSpec[] = [
  { id: "mom", name: "Vol-adjusted momentum", formula: "ln(c_i / c_{i-W}) / (σ_1bar · √W)", window: "W bars", normalization: "robust_z", provenance: "observed", sources: ["reference klines/trades"], weight: 0.3, reliability: "high" },
  { id: "spotFlow", name: "Spot flow ratio", formula: "Σ(spotBuy − spotSell) / Σ(spotBuy + spotSell) over W", window: "W bars", normalization: "robust_z", provenance: "observed", sources: ["spot taker volume"], weight: 0.25, reliability: "high" },
  { id: "perpFlow", name: "Perp flow ratio", formula: "Σ(perpBuy − perpSell) / Σ(perpBuy + perpSell) over W", window: "W bars", normalization: "robust_z", provenance: "observed", sources: ["perp taker volume"], weight: 0.2, reliability: "high" },
  { id: "spotShare", name: "Spot share of volume", formula: "Σ spotVol / Σ (spotVol + perpVol) over W", window: "W bars", normalization: "robust_z", provenance: "observed", sources: ["spot & perp volume"], weight: 0.1, reliability: "medium" },
  { id: "oiChg", name: "Open interest change", formula: "ln(OI_i / OI_{i-W})", window: "W bars", normalization: "robust_z", provenance: "observed", sources: ["perp open interest"], weight: 0.15, reliability: "medium" },
  { id: "funding", name: "Funding rate", formula: "funding_i (per 8h)", window: "point", normalization: "robust_z", provenance: "observed", sources: ["perp funding"], weight: 0.1, reliability: "medium" },
  { id: "basis", name: "Perp basis", formula: "(perpClose − spotClose) / spotClose (bps)", window: "point", normalization: "robust_z", provenance: "observed", sources: ["spot & perp close"], weight: 0.1, reliability: "medium" },
  { id: "liqImb", name: "Liquidation imbalance", formula: "Σ(liqShort − liqLong) / Σ(liqShort + liqLong) over W", window: "W bars", normalization: "raw", provenance: "observed", sources: ["venue liquidation feeds (live only)"], weight: 0.1, reliability: "low" },
  { id: "volRatio", name: "Volatility ratio", formula: "σ(returns, W) / σ(returns, 4W)", window: "W & 4W bars", normalization: "robust_z", provenance: "observed", sources: ["closes"], weight: 0.15, reliability: "high" },
  { id: "rangePos", name: "Range position", formula: "(c_i − min l_{4W}) / (max h_{4W} − min l_{4W})", window: "4W bars", normalization: "raw", provenance: "observed", sources: ["OHLC"], weight: 0.1, reliability: "high" },
  { id: "impact", name: "Price impact (Kyle λ)", formula: "OLS slope of r_j on netFlow_j / vol_j over 3W bars", window: "3W bars", normalization: "robust_z", provenance: "modeled", sources: ["returns", "signed volume"], weight: 0.15, reliability: "medium" },
  { id: "volume", name: "Relative volume", formula: "ln(Σ vol over W)", window: "W bars", normalization: "robust_z", provenance: "observed", sources: ["volume"], weight: 0.05, reliability: "high" },
];

export type FeatureId = "mom" | "spotFlow" | "perpFlow" | "spotShare" | "oiChg" | "funding" | "basis" | "liqImb" | "volRatio" | "rangePos" | "impact" | "volume";
export type FeatureVec = Record<FeatureId, number | null>;

function stdRet(bars: Bar[], from: number, to: number): number | null {
  const r: number[] = [];
  for (let j = Math.max(1, from); j <= to; j++) if (bars[j - 1].c > 0) r.push(Math.log(bars[j].c / bars[j - 1].c));
  if (r.length < 3) return null;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
}

export function computeFeatures(bars: Bar[], i: number, W = 12): FeatureVec {
  const v: FeatureVec = { mom: null, spotFlow: null, perpFlow: null, spotShare: null, oiChg: null, funding: null, basis: null, liqImb: null, volRatio: null, rangePos: null, impact: null, volume: null };
  if (i < W) return v;
  const b = bars[i];
  const s1 = stdRet(bars, i - 4 * W + 1, i);
  const sw = stdRet(bars, i - W + 1, i);
  if (s1 && s1 > 0) v.mom = Math.log(b.c / bars[i - W].c) / (s1 * Math.sqrt(W));
  if (s1 && sw !== null && s1 > 0 && i >= 4 * W) v.volRatio = sw / s1;

  let sd = 0, sv = 0, pd = 0, pv = 0, spotOk = true, perpOk = true, lS = 0, lL = 0, vol = 0;
  for (let j = i - W + 1; j <= i; j++) {
    const x = bars[j];
    const s = spotDelta(x), p = perpDelta(x);
    if (s === null) spotOk = false; else { sd += s; sv += (x.spotBuy ?? 0) + (x.spotSell ?? 0); }
    if (p === null) perpOk = false; else { pd += p; pv += (x.perpBuy ?? 0) + (x.perpSell ?? 0); }
    lS += x.liqShort; lL += x.liqLong;
    vol += (x.spotBuy ?? 0) + (x.spotSell ?? 0) + (x.perpBuy ?? 0) + (x.perpSell ?? 0);
  }
  if (spotOk && sv > 0) v.spotFlow = sd / sv;
  if (perpOk && pv > 0) v.perpFlow = pd / pv;
  if (spotOk && perpOk && sv + pv > 0) v.spotShare = sv / (sv + pv);
  if (lS + lL > 0) v.liqImb = (lS - lL) / (lS + lL);
  if (vol > 0) v.volume = Math.log(vol);
  const oi0 = bars[i - W].oi, oi1 = b.oi;
  if (oi0 && oi1 && oi0 > 0) v.oiChg = Math.log(oi1 / oi0);
  v.funding = b.funding;
  v.basis = b.basisBps;

  if (i >= 4 * W) {
    let lo = Infinity, hi = -Infinity;
    for (let j = i - 4 * W + 1; j <= i; j++) { lo = Math.min(lo, bars[j].l); hi = Math.max(hi, bars[j].h); }
    if (hi > lo) v.rangePos = (b.c - lo) / (hi - lo);
  }
  // Kyle lambda on normalized flow
  if (i >= 3 * W) {
    const xs: number[] = [], ys: number[] = [];
    for (let j = i - 3 * W + 1; j <= i; j++) {
      const x = bars[j];
      const s = spotDelta(x) ?? 0, p = perpDelta(x) ?? 0;
      const tv = (x.spotBuy ?? 0) + (x.spotSell ?? 0) + (x.perpBuy ?? 0) + (x.perpSell ?? 0);
      if (tv <= 0 || bars[j - 1].c <= 0) continue;
      xs.push((s + p) / tv);
      ys.push(Math.log(x.c / bars[j - 1].c) * 10_000);
    }
    const lr = linreg(xs, ys);
    if (lr && xs.length >= W) v.impact = lr.slope;
  }
  return v;
}

/**
 * Caches feature vectors per bar open time so each closed bar is computed once,
 * and z-scores each feature against its trailing history (point-in-time).
 */
export class FeatureStore {
  private cache = new Map<number, FeatureVec>();
  constructor(readonly W = 12, readonly zLookback = 500) {}

  evaluate(bars: Bar[]): { raw: FeatureVec; z: FeatureVec; history: FeatureVec[] } | null {
    if (bars.length < this.W + 2) return null;
    const last = bars.length - 1;
    const start = Math.max(this.W, last - this.zLookback);
    const history: FeatureVec[] = [];
    for (let i = start; i < last; i++) {
      const t = bars[i].t;
      let fv = this.cache.get(t);
      if (!fv) {
        fv = computeFeatures(bars, i, this.W);
        this.cache.set(t, fv);
      }
      history.push(fv);
    }
    if (this.cache.size > this.zLookback * 2) {
      const keep = new Set(bars.slice(-this.zLookback - 5).map((b) => b.t));
      for (const k of this.cache.keys()) if (!keep.has(k)) this.cache.delete(k);
    }
    const raw = computeFeatures(bars, last, this.W); // current (possibly partial) bar recomputed every tick
    const z = {} as FeatureVec;
    for (const k of Object.keys(raw) as FeatureId[]) {
      const r = raw[k];
      if (r === null || k === "liqImb" || k === "rangePos") { z[k] = r === null ? null : k === "rangePos" ? (r - 0.5) * 4 : r * 2; continue; }
      const h = history.map((x) => x[k]).filter((x): x is number => x !== null);
      z[k] = robustZ(r, h, 30);
    }
    return { raw, z, history };
  }
}

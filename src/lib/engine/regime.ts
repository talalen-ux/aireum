import type { Evidence, Timeframe } from "../core/types";
import { clamp, squash } from "../core/stats";
import type { Bar } from "./bars";
import { FeatureStore, type FeatureId, type FeatureVec } from "./features";

export type RegimeId =
  | "forced_deleveraging"
  | "spot_accumulation"
  | "distribution"
  | "short_squeeze"
  | "long_squeeze"
  | "range_harvesting"
  | "trend_continuation_up"
  | "trend_continuation_down"
  | "breakout_expansion"
  | "volatility_compression"
  | "macro_repricing";

export const REGIME_LABEL: Record<RegimeId, string> = {
  forced_deleveraging: "Forced deleveraging",
  spot_accumulation: "Spot accumulation",
  distribution: "Distribution",
  short_squeeze: "Short squeeze",
  long_squeeze: "Long squeeze",
  range_harvesting: "Range liquidity harvesting",
  trend_continuation_up: "Trend continuation ↑",
  trend_continuation_down: "Trend continuation ↓",
  breakout_expansion: "Breakout expansion",
  volatility_compression: "Volatility compression",
  macro_repricing: "Macro repricing",
};

export interface RegimeScore {
  id: RegimeId;
  /** membership strength in [0,1]; ≥0.5 = active. Overlapping regimes are allowed. */
  score: number | null;
  evidence: Evidence[];
  unavailableReason?: string;
}

export interface TfAssessment {
  tf: Timeframe;
  ts: number;
  bars: number;
  /** [-1,1] signed: + = buy-side pressure */
  directionalPressure: number | null;
  /** [0,1] */
  liquidityFragility: number | null;
  reversalPotential: number | null;
  crowding: number | null;
  /** which side is crowded (risk of being squeezed) */
  crowdedSide: "long" | "short" | null;
  dataConfidence: number;
  leadership: "spot" | "perp" | "mixed" | null;
  regimes: RegimeScore[];
  primary: RegimeId | null;
  features: { raw: FeatureVec; z: FeatureVec } | null;
  warmingUp: boolean;
}

/** fuzzy membership: ≈0 below thr, ≈1 above, smooth */
const above = (z: number | null, thr: number) => (z === null ? null : squash((z - thr) * 2.5));
const below = (z: number | null, thr: number) => (z === null ? null : squash((thr - z) * 2.5));

/** geometric mean of available memberships; returns null if fewer than `min` are available */
function all(ms: (number | null)[], min = ms.length): number | null {
  const v = ms.filter((x): x is number => x !== null);
  if (v.length < min) return null;
  return Math.exp(v.reduce((a, b) => a + Math.log(Math.max(1e-6, b)), 0) / v.length);
}

const fz = (z: number | null) => (z === null ? "n/a" : `${z >= 0 ? "+" : ""}${z.toFixed(2)}σ`);

export function assessTimeframe(tf: Timeframe, bars: Bar[], store: FeatureStore, ctx: { flowAvailable: boolean; liveBookFragility?: number | null; macroAvailable: boolean }): TfAssessment {
  const ts = bars.length ? bars[bars.length - 1].t : 0;
  const ev = store.evaluate(bars);
  const base: TfAssessment = { tf, ts, bars: bars.length, directionalPressure: null, liquidityFragility: null, reversalPotential: null, crowding: null, crowdedSide: null, dataConfidence: 0, leadership: null, regimes: [], primary: null, features: null, warmingUp: true };
  if (!ev) return base;
  const { raw, z } = ev;
  const E = (label: string, id: FeatureId, stance: 1 | -1 | 0, fmtRaw?: (x: number) => string): Evidence => ({
    label,
    value: `${raw[id] === null ? "n/a" : fmtRaw ? fmtRaw(raw[id] as number) : (raw[id] as number).toFixed(3)} (${fz(z[id])})`,
    provenance: id === "impact" ? "modeled" : "observed",
    stance,
    source: `${tf} bars · ${id}`,
    ts,
  });

  // ---- Scores ------------------------------------------------------------
  const pressureParts: [number | null, number][] = [
    [z.mom, 0.35],
    [z.spotFlow, 0.25],
    [z.perpFlow, 0.2],
    [z.oiChg !== null && z.mom !== null ? z.oiChg * Math.sign(z.mom) * 0.5 : null, 0.1],
    [raw.liqImb !== null ? raw.liqImb * 1.5 : null, 0.1],
  ];
  const dp = weighted(pressureParts);
  const directionalPressure = dp === null ? null : Math.tanh(dp / 1.5);

  // Fragility: vol expansion, impact elevated, thin book (live)
  const fragParts: [number | null, number][] = [
    [z.volRatio, 0.35],
    [z.impact !== null ? Math.abs(z.impact) : null, 0.35],
    [ctx.liveBookFragility !== undefined && ctx.liveBookFragility !== null ? (ctx.liveBookFragility - 0.5) * 4 : null, 0.3],
  ];
  const fr = weighted(fragParts);
  const liquidityFragility = fr === null ? null : squash(fr, 1.2);

  // Crowding: funding & basis elevated in one direction with rising OI
  let crowding: number | null = null;
  let crowdedSide: "long" | "short" | null = null;
  if (z.funding !== null || z.basis !== null) {
    const lev = (z.funding ?? 0) * 0.5 + (z.basis ?? 0) * 0.3 + (z.oiChg ?? 0) * 0.2 * Math.sign((z.funding ?? 0) + (z.basis ?? 0) || 1);
    crowdedSide = lev >= 0 ? "long" : "short";
    crowding = squash(Math.abs(lev) - 1, 2);
  }

  // Reversal potential: price at range extreme while flow-impact diverges (absorption) or momentum stretched
  let reversalPotential: number | null = null;
  if (raw.rangePos !== null && z.mom !== null) {
    const extreme = Math.abs(raw.rangePos - 0.5) * 2; // 0 center → 1 extreme
    const stretched = squash(Math.abs(z.mom) - 1.5, 2);
    const flowDir = (z.spotFlow ?? 0) + (z.perpFlow ?? 0);
    // flow pushing in the move's direction but impact falling = absorption
    const absorb = z.impact !== null ? squash(-z.impact - 0.5, 2) * squash(Math.abs(flowDir) - 1, 2) : 0.5 * squash(Math.abs(flowDir) - 1, 2);
    reversalPotential = clamp(0.4 * extreme + 0.3 * stretched + 0.3 * absorb, 0, 1);
  }

  // Leadership: spot vs perp flow alignment with momentum
  let leadership: TfAssessment["leadership"] = null;
  if (z.spotFlow !== null && z.perpFlow !== null && z.mom !== null) {
    const s = z.spotFlow * Math.sign(z.mom), p = z.perpFlow * Math.sign(z.mom);
    leadership = s > p + 0.5 ? "spot" : p > s + 0.5 ? "perp" : "mixed";
  }

  // Data confidence: fraction of features available, history depth
  const avail = (Object.keys(z) as FeatureId[]).filter((k) => z[k] !== null).length / Object.keys(z).length;
  const depth = clamp(ev.history.length / 300, 0, 1);
  const dataConfidence = clamp(0.6 * avail + 0.4 * depth, 0, 1) * (ctx.flowAvailable ? 1 : 0.7);

  // ---- Regimes -----------------------------------------------------------
  const R: RegimeScore[] = [];
  const add = (id: RegimeId, score: number | null, evidence: Evidence[], unavailableReason?: string) => R.push({ id, score, evidence, unavailableReason });

  add("forced_deleveraging", all([below(z.oiChg, -1.2), above(z.volRatio, 0.8), above(z.mom !== null ? Math.abs(z.mom) : null, 1)], 2), [
    E("OI change", "oiChg", (z.oiChg ?? 0) < -1 ? 1 : -1, (x) => `${(x * 100).toFixed(2)}%`),
    E("Vol ratio", "volRatio", (z.volRatio ?? 0) > 0.8 ? 1 : -1),
    E("Momentum", "mom", Math.abs(z.mom ?? 0) > 1 ? 1 : -1),
  ]);
  add("spot_accumulation", all([above(z.spotFlow, 0.8), below(z.mom, 1.2), above(z.mom, -1), below(z.perpFlow !== null && z.spotFlow !== null ? z.perpFlow - z.spotFlow : null, 0)], 2), [
    E("Spot flow", "spotFlow", (z.spotFlow ?? 0) > 0.8 ? 1 : -1, (x) => `${(x * 100).toFixed(1)}%`),
    E("Momentum (not chasing)", "mom", Math.abs(z.mom ?? 0) < 1.2 ? 1 : -1),
    E("Perp flow", "perpFlow", 0, (x) => `${(x * 100).toFixed(1)}%`),
  ]);
  add("distribution", all([below(z.spotFlow, -0.8), above(z.mom, -1.2), above(raw.rangePos !== null ? (raw.rangePos - 0.5) * 4 : null, 0.5)], 2), [
    E("Spot flow", "spotFlow", (z.spotFlow ?? 0) < -0.8 ? 1 : -1, (x) => `${(x * 100).toFixed(1)}%`),
    E("Range position", "rangePos", (raw.rangePos ?? 0) > 0.6 ? 1 : -1, (x) => `${(x * 100).toFixed(0)}%`),
    E("Momentum", "mom", 0),
  ]);
  add("short_squeeze", all([above(z.mom, 1), below(z.oiChg, -0.5), above(raw.liqImb !== null ? raw.liqImb * 2 : null, 0.5), below(z.funding, 0.5)], 2), [
    E("Momentum", "mom", (z.mom ?? 0) > 1 ? 1 : -1),
    E("OI change", "oiChg", (z.oiChg ?? 0) < -0.5 ? 1 : -1, (x) => `${(x * 100).toFixed(2)}%`),
    E("Liq imbalance (shorts)", "liqImb", (raw.liqImb ?? 0) > 0.25 ? 1 : 0, (x) => x.toFixed(2)),
    E("Funding", "funding", (z.funding ?? 0) < 0.5 ? 1 : -1, (x) => `${(x * 1e4).toFixed(2)}bp`),
  ]);
  add("long_squeeze", all([below(z.mom, -1), below(z.oiChg, -0.5), below(raw.liqImb !== null ? raw.liqImb * 2 : null, -0.5), above(z.funding, -0.5)], 2), [
    E("Momentum", "mom", (z.mom ?? 0) < -1 ? 1 : -1),
    E("OI change", "oiChg", (z.oiChg ?? 0) < -0.5 ? 1 : -1, (x) => `${(x * 100).toFixed(2)}%`),
    E("Liq imbalance (longs)", "liqImb", (raw.liqImb ?? 0) < -0.25 ? 1 : 0, (x) => x.toFixed(2)),
    E("Funding", "funding", (z.funding ?? 0) > -0.5 ? 1 : -1, (x) => `${(x * 1e4).toFixed(2)}bp`),
  ]);
  add("range_harvesting", all([below(z.mom !== null ? Math.abs(z.mom) : null, 0.8), below(z.volRatio !== null ? Math.abs(z.volRatio) : null, 1), above(raw.rangePos !== null ? Math.abs(raw.rangePos - 0.5) * 4 : null, 0.6)], 2), [
    E("|Momentum| small", "mom", Math.abs(z.mom ?? 9) < 0.8 ? 1 : -1),
    E("Vol ratio normal", "volRatio", Math.abs(z.volRatio ?? 9) < 1 ? 1 : -1),
    E("Testing range edge", "rangePos", Math.abs((raw.rangePos ?? 0.5) - 0.5) > 0.3 ? 1 : 0, (x) => `${(x * 100).toFixed(0)}%`),
  ]);
  const flowAligned = (sign: 1 | -1) => (z.spotFlow === null && z.perpFlow === null ? null : ((z.spotFlow ?? 0) + (z.perpFlow ?? 0)) * sign);
  add("trend_continuation_up", all([above(z.mom, 0.8), above(flowAligned(1), 0.5), above(z.oiChg, -0.3)], 2), [
    E("Momentum", "mom", (z.mom ?? 0) > 0.8 ? 1 : -1),
    E("Spot flow", "spotFlow", (z.spotFlow ?? 0) > 0 ? 1 : -1, (x) => `${(x * 100).toFixed(1)}%`),
    E("OI change", "oiChg", (z.oiChg ?? 0) > -0.3 ? 1 : -1, (x) => `${(x * 100).toFixed(2)}%`),
  ]);
  add("trend_continuation_down", all([below(z.mom, -0.8), above(flowAligned(-1), 0.5), above(z.oiChg, -0.3)], 2), [
    E("Momentum", "mom", (z.mom ?? 0) < -0.8 ? 1 : -1),
    E("Spot flow", "spotFlow", (z.spotFlow ?? 0) < 0 ? 1 : -1, (x) => `${(x * 100).toFixed(1)}%`),
    E("OI change", "oiChg", (z.oiChg ?? 0) > -0.3 ? 1 : -1, (x) => `${(x * 100).toFixed(2)}%`),
  ]);
  add("breakout_expansion", all([above(z.volRatio, 1.2), above(raw.rangePos !== null ? Math.abs(raw.rangePos - 0.5) * 4 : null, 1.6), above(z.volume, 0.8)], 2), [
    E("Vol ratio", "volRatio", (z.volRatio ?? 0) > 1.2 ? 1 : -1),
    E("At range extreme", "rangePos", Math.abs((raw.rangePos ?? 0.5) - 0.5) > 0.4 ? 1 : -1, (x) => `${(x * 100).toFixed(0)}%`),
    E("Relative volume", "volume", (z.volume ?? 0) > 0.8 ? 1 : -1),
  ]);
  add("volatility_compression", all([below(z.volRatio, -1), below(z.volume, 0)], 1), [
    E("Vol ratio", "volRatio", (z.volRatio ?? 0) < -1 ? 1 : -1),
    E("Relative volume", "volume", (z.volume ?? 0) < 0 ? 1 : -1),
  ]);
  add("macro_repricing", null, [], ctx.macroAvailable ? undefined : "Requires macro feeds (yields, DXY, calendar). Connect a macro source.");

  const ranked = R.filter((r) => r.score !== null).sort((a, b) => (b.score as number) - (a.score as number));
  const primary = ranked.length && (ranked[0].score as number) >= 0.5 ? ranked[0].id : null;

  return {
    tf, ts, bars: bars.length, directionalPressure, liquidityFragility, reversalPotential, crowding, crowdedSide, dataConfidence, leadership, regimes: R, primary,
    features: { raw, z }, warmingUp: ev.history.length < 60,
  };
}

function weighted(parts: [number | null, number][]): number | null {
  let s = 0, w = 0;
  for (const [v, wt] of parts) if (v !== null && Number.isFinite(v)) { s += v * wt; w += wt; }
  return w >= 0.4 ? s / w : null;
}

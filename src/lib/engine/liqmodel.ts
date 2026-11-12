import { clamp } from "../core/stats";
import type { Bar } from "./bars";

/**
 * MODELED liquidation clusters — explicitly NOT observable data.
 *
 * Method: walk perp bars; when OI increases, attribute the new contracts to longs vs
 * shorts by the bar's perp taker-flow ratio (assumption), place them at the bar's
 * VWAP-proxy (close), and spread them across an assumed leverage distribution.
 * Estimated liquidation price per leverage L (isolated, linear, MMR m):
 *     long:  P·(1 − 1/L + m)      short: P·(1 + 1/L − m)
 * When OI decreases, existing exposure is reduced pro-rata (positions closed).
 * When price trades through a cluster, that cluster is removed (liquidated or closed).
 * Three leverage scenarios give a low / base / high uncertainty band.
 */
export const LEVERAGE_SCENARIOS: Record<"low" | "base" | "high", [number, number][]> = {
  low: [[2, 0.2], [3, 0.2], [5, 0.25], [10, 0.25], [20, 0.07], [50, 0.03]],
  base: [[3, 0.1], [5, 0.17], [10, 0.28], [20, 0.2], [25, 0.1], [50, 0.1], [100, 0.05]],
  high: [[5, 0.1], [10, 0.2], [20, 0.25], [25, 0.15], [50, 0.18], [100, 0.12]],
};
export const LIQ_MODEL_ASSUMPTIONS = [
  "New OI is split long/short by the bar's perp taker-flow ratio (clamped 20–80%).",
  "Positions open at the bar close; leverage follows an assumed distribution (low/base/high scenarios).",
  "Isolated-margin linear formula with 0.5% maintenance margin; cross-margin positions liquidate later.",
  "OI reductions close exposure pro-rata; price trading through a band removes it.",
  "Reference OI is one venue (scaled to aggregate if available) — real positioning is not public.",
];

export interface LiqBucket {
  price: number;
  longUsd: number; // long liquidations (forced sells) estimated at/below price
  shortUsd: number; // short liquidations (forced buys) estimated at/above price
  longLow: number;
  longHigh: number;
  shortLow: number;
  shortHigh: number;
}

export interface LiqMap {
  buckets: LiqBucket[];
  step: number;
  price: number;
  nearestLongCluster: { price: number; usd: number; distPct: number } | null;
  nearestShortCluster: { price: number; usd: number; distPct: number } | null;
  totalLongUsd: number;
  totalShortUsd: number;
  assumptions: string[];
  barsUsed: number;
  scale: number;
}

type Book = Map<number, number>; // bucket price -> USD

function runScenario(bars: Bar[], lev: [number, number][], step: number, mmr: number, scale: number) {
  const longs: Book = new Map(), shorts: Book = new Map();
  let prevOi: number | null = null;
  for (const b of bars) {
    if (b.oi === null) continue;
    const px = b.c;
    // remove clusters traded through
    for (const [k] of longs) if (b.l <= k) longs.delete(k);
    for (const [k] of shorts) if (b.h >= k) shorts.delete(k);
    if (prevOi !== null) {
      const dOi = (b.oi - prevOi) * scale;
      if (dOi > 0) {
        const pb = b.perpBuy ?? 0, ps = b.perpSell ?? 0;
        const ratio = pb + ps > 0 ? (pb - ps) / (pb + ps) : 0;
        const longShare = clamp(0.5 + ratio * 2, 0.2, 0.8);
        const usd = dOi * px;
        for (const [L, w] of lev) {
          const lp = px * (1 - 1 / L + mmr), sp = px * (1 + 1 / L - mmr);
          const lk = Math.floor(lp / step) * step, sk = Math.ceil(sp / step) * step;
          longs.set(lk, (longs.get(lk) ?? 0) + usd * longShare * w);
          shorts.set(sk, (shorts.get(sk) ?? 0) + usd * (1 - longShare) * w);
        }
      } else if (dOi < 0) {
        const totalUsd = sum(longs) + sum(shorts);
        const remove = -dOi * px;
        const f = totalUsd > 0 ? clamp(1 - remove / totalUsd, 0, 1) : 1;
        for (const [k, v] of longs) longs.set(k, v * f);
        for (const [k, v] of shorts) shorts.set(k, v * f);
      }
    }
    prevOi = b.oi;
  }
  return { longs, shorts };
}

const sum = (m: Book) => { let s = 0; for (const v of m.values()) s += v; return s; };

export function buildLiqMap(bars: Bar[], price: number | null, opts: { rangePct?: number; buckets?: number; mmr?: number; scale?: number } = {}): LiqMap | null {
  if (!price || bars.filter((b) => b.oi !== null).length < 20) return null;
  const rangePct = opts.rangePct ?? 0.12;
  const nB = opts.buckets ?? 120;
  const step = niceStep((price * 2 * rangePct) / nB);
  const mmr = opts.mmr ?? 0.005;
  const scale = opts.scale ?? 1;
  const sc = { low: runScenario(bars, LEVERAGE_SCENARIOS.low, step, mmr, scale), base: runScenario(bars, LEVERAGE_SCENARIOS.base, step, mmr, scale), high: runScenario(bars, LEVERAGE_SCENARIOS.high, step, mmr, scale) };
  const lo = Math.floor((price * (1 - rangePct)) / step) * step;
  const hi = Math.ceil((price * (1 + rangePct)) / step) * step;
  const buckets: LiqBucket[] = [];
  let totalLong = 0, totalShort = 0;
  for (let p = lo; p <= hi + 1e-9; p += step) {
    const k = Math.round(p / step) * step;
    const g = (m: Book) => m.get(k) ?? 0;
    const vals = { lb: g(sc.base.longs), ll: g(sc.low.longs), lh: g(sc.high.longs), sb: g(sc.base.shorts), sl: g(sc.low.shorts), sh: g(sc.high.shorts) };
    const b: LiqBucket = { price: k, longUsd: k < price ? vals.lb : 0, shortUsd: k > price ? vals.sb : 0, longLow: k < price ? Math.min(vals.ll, vals.lh, vals.lb) : 0, longHigh: k < price ? Math.max(vals.ll, vals.lh, vals.lb) : 0, shortLow: k > price ? Math.min(vals.sl, vals.sh, vals.sb) : 0, shortHigh: k > price ? Math.max(vals.sl, vals.sh, vals.sb) : 0 };
    totalLong += b.longUsd; totalShort += b.shortUsd;
    buckets.push(b);
  }
  // nearest "major" cluster = first bucket with ≥ 2× mean non-zero size on each side
  const major = (side: "long" | "short") => {
    const arr = buckets.filter((b) => (side === "long" ? b.longUsd : b.shortUsd) > 0);
    if (!arr.length) return null;
    const mean = arr.reduce((a, b) => a + (side === "long" ? b.longUsd : b.shortUsd), 0) / arr.length;
    const ordered = side === "long" ? [...arr].sort((a, b) => b.price - a.price) : [...arr].sort((a, b) => a.price - b.price);
    const hit = ordered.find((b) => (side === "long" ? b.longUsd : b.shortUsd) >= 2 * mean);
    return hit ? { price: hit.price, usd: side === "long" ? hit.longUsd : hit.shortUsd, distPct: (hit.price - price) / price } : null;
  };
  return { buckets, step, price, nearestLongCluster: major("long"), nearestShortCluster: major("short"), totalLongUsd: totalLong, totalShortUsd: totalShort, assumptions: LIQ_MODEL_ASSUMPTIONS, barsUsed: bars.length, scale };
}

export function niceStep(x: number) {
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / e;
  return (f < 1.5 ? 1 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10) * e;
}

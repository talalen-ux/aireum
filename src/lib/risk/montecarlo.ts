/**
 * Path-dependent Monte Carlo for a planned position. MODELED output — the distribution of
 * outcomes under explicit assumptions, not a forecast.
 *
 * Each path simulates MARK price at fixed steps. Per step the order of evaluation is:
 *   1. liquidation (mark crosses liq) — unless a stop sits between the previous price and liq and
 *      does not fail, in which case the stop executes first (continuous path passes the stop first);
 *   2. stop ladder legs (fill at stop ± slippage; gap-through fills at the step's price);
 *   3. target ladder legs (limit fills at target price).
 * Liquidation and stops close their legs; liquidation loses the remaining isolated margin share.
 * The path keeps evolving after liquidation so we can measure "liquidated before rebound".
 */
import { gaussian, mulberry32, quantile } from "@/lib/core/stats";
import type { PosSide } from "./exchanges";

export type MCModel = "gbm" | "jump" | "student_t" | "bootstrap";

export interface MCParams {
  seed: number;
  paths: number;
  horizonHours: number;
  stepsPerHour: number;
  /** Annualized volatility (fraction), e.g. 0.55. Ignored for bootstrap. */
  annualVol: number;
  /** Annualized drift; default 0 (no directional assumption). */
  annualDrift?: number;
  model: MCModel;
  /** Student-t degrees of freedom (fat tails). */
  tDof?: number;
  /** Jumps per day (Poisson intensity), mean & stdev of log jump size. */
  jumpsPerDay?: number;
  jumpMean?: number;
  jumpStd?: number;
  /** Per-step log returns to bootstrap from (e.g. recent 1m returns, rescaled to step size by caller). */
  returns?: number[];
  /** Probability a stop fails to fill near its price (fills at step end + extra slippage). */
  stopFailProb: number;
  stopSlippageBps: number;
  /** Number of sample paths returned for charting. */
  samplePaths?: number;
}

export interface MCPosition {
  side: PosSide;
  qty: number;
  entry: number;
  start: number; // starting mark
  liq: number | null;
  /** Isolated margin at risk (USD). Liquidation loses this share for the liquidated quantity. */
  margin: number;
  stops: { price: number; fraction: number }[];
  targets: { price: number; fraction: number }[];
  takerFee: number;
  makerFee: number;
  entryFeeRate: number;
  fundingRate: number;
  fundingIntervalHours: number;
}

export interface MCResult {
  provenance: "modeled";
  assumptions: string[];
  paths: number;
  pLiquidation: number;
  pLiqBeforeFirstTarget: number;
  /** Liquidated, yet price at horizon would have been on the profitable side of entry. */
  pLiqBeforeRebound: number;
  pStop: number;
  pStopFailed: number;
  pTargets: number[];
  expectedPnl: number;
  pnlQuantiles: { p05: number; p25: number; p50: number; p75: number; p95: number };
  /** Max adverse excursion as fraction of entry. */
  maeQuantiles: { p50: number; p90: number; p99: number };
  sample: number[][]; // downsampled price paths
  steps: number;
}

function studentT(rand: () => number, dof: number) {
  // t = Z / sqrt(ChiSq/dof); chi-square via sum of squared normals (dof small integer)
  const z = gaussian(rand);
  let chi = 0;
  const k = Math.max(3, Math.round(dof));
  for (let i = 0; i < k; i++) chi += gaussian(rand) ** 2;
  // rescale to unit variance: Var(t) = dof/(dof-2)
  return (z / Math.sqrt(chi / k)) * Math.sqrt((k - 2) / k);
}

function poisson(rand: () => number, lambda: number) {
  if (lambda <= 0) return 0;
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  do { k++; p *= rand(); } while (p > L);
  return k - 1;
}

export function describeAssumptions(p: MCParams): string[] {
  const a = [
    `Model: ${p.model}${p.model === "student_t" ? ` (ν=${p.tDof ?? 4})` : ""}${p.model === "jump" ? ` (${p.jumpsPerDay ?? 1}/day, μ=${p.jumpMean ?? 0}, σ=${p.jumpStd ?? 0.02})` : ""}`,
    p.model === "bootstrap" ? `Bootstrapped from ${p.returns?.length ?? 0} observed returns (i.i.d., no volatility clustering)` : `Annualized vol ${(p.annualVol * 100).toFixed(0)}%, drift ${(((p.annualDrift ?? 0)) * 100).toFixed(0)}% (no directional view)`,
    `${p.paths.toLocaleString()} paths × ${Math.round(p.horizonHours * p.stepsPerHour)} steps, seed ${p.seed} (deterministic)`,
    "Simulates mark price; mark/last basis assumed zero",
    `Stops: ${p.stopSlippageBps}bp slippage; ${(p.stopFailProb * 100).toFixed(1)}% chance of failing to fill near trigger`,
    "Isolated margin released pro-rata on partial closes (liquidation price constant)",
    "Funding accrues linearly at the current rate; fees at stated maker/taker rates",
  ];
  return a;
}

export function* monteCarloIter(pos: MCPosition, p: MCParams): Generator<number, MCResult, void> {
  const rand = mulberry32(p.seed);
  const steps = Math.max(1, Math.round(p.horizonHours * p.stepsPerHour));
  const dtYears = 1 / (p.stepsPerHour * 24 * 365);
  const sigma = p.annualVol * Math.sqrt(dtYears);
  const mu = ((p.annualDrift ?? 0) - 0.5 * p.annualVol ** 2) * dtYears;
  const lambdaStep = ((p.jumpsPerDay ?? 1) / 24) / p.stepsPerHour;
  const s = pos.side === "long" ? 1 : -1;
  const nSample = Math.min(p.samplePaths ?? 40, p.paths);
  const sampleEvery = Math.max(1, Math.ceil(steps / 80));
  const fundingPerStep = s * pos.fundingRate * (pos.qty * pos.entry) / (pos.fundingIntervalHours * p.stepsPerHour);
  const entryFees = pos.qty * pos.entry * pos.entryFeeRate;
  const boot = p.returns?.filter(Number.isFinite) ?? [];

  const pnls: number[] = [];
  const maes: number[] = [];
  const sample: number[][] = [];
  let nLiq = 0, nLiqBeforeT1 = 0, nLiqRebound = 0, nStop = 0, nStopFail = 0;
  const nTargets = new Array(pos.targets.length).fill(0);

  // sort ladders in order of being reached from entry
  const stops = pos.stops.map((x, i) => ({ ...x, i })).sort((a, b) => s * (b.price - a.price));
  const targets = pos.targets.map((x, i) => ({ ...x, i })).sort((a, b) => s * (a.price - b.price));

  for (let k = 0; k < p.paths; k++) {
    let price = pos.start;
    let remaining = 1; // fraction of position open
    let realized = 0;
    let liquidated = false;
    let hitTarget = false;
    let stopHit = false;
    let mae = 0;
    const stopDone = new Array(stops.length).fill(false);
    const tgtDone = new Array(targets.length).fill(false);
    const path: number[] | null = k < nSample ? [price] : null;
    let funding = 0;

    for (let t = 1; t <= steps; t++) {
      const prev = price;
      let r: number;
      if (p.model === "bootstrap" && boot.length) r = boot[Math.floor(rand() * boot.length)];
      else if (p.model === "student_t") r = mu + sigma * studentT(rand, p.tDof ?? 4);
      else {
        r = mu + sigma * gaussian(rand);
        if (p.model === "jump") {
          const nj = poisson(rand, lambdaStep);
          for (let j = 0; j < nj; j++) r += (p.jumpMean ?? 0) + (p.jumpStd ?? 0.02) * gaussian(rand);
        }
      }
      price = prev * Math.exp(r);
      if (path && t % sampleEvery === 0) path.push(price);
      if (remaining <= 1e-12) continue;

      funding += fundingPerStep * remaining;
      const adverse = (s * (pos.entry - price)) / pos.entry;
      if (adverse > mae) mae = adverse;

      // stops between prev and price (adverse move)
      const lo = Math.min(prev, price), hi = Math.max(prev, price);
      const liqCrossed = pos.liq !== null && (s > 0 ? price <= pos.liq : price >= pos.liq);
      for (let j = 0; j < stops.length; j++) {
        if (stopDone[j]) continue;
        const sp = stops[j].price;
        if (sp < lo || sp > hi || (s > 0 ? price > sp : price < sp)) continue;
        const failed = rand() < p.stopFailProb;
        if (failed && liqCrossed) continue; // stop failed; liquidation takes it
        stopDone[j] = true;
        const frac = Math.min(remaining, stops[j].fraction);
        const fill = failed ? price * (1 - s * (p.stopSlippageBps * 3) / 1e4) : sp * (1 - s * p.stopSlippageBps / 1e4);
        if (failed) nStopFail++;
        realized += s * (fill - pos.entry) * pos.qty * frac - pos.qty * frac * fill * pos.takerFee;
        remaining -= frac;
        stopHit = true;
      }
      if (remaining > 1e-12 && liqCrossed) {
        liquidated = true;
        realized -= pos.margin * remaining;
        remaining = 0;
        nLiq++;
        if (!hitTarget) nLiqBeforeT1++;
        continue;
      }
      for (let j = 0; j < targets.length; j++) {
        if (tgtDone[j] || remaining <= 1e-12) continue;
        if (s > 0 ? price >= targets[j].price : price <= targets[j].price) {
          tgtDone[j] = true;
          hitTarget = true;
          nTargets[targets[j].i]++;
          const frac = Math.min(remaining, targets[j].fraction);
          realized += s * (targets[j].price - pos.entry) * pos.qty * frac - pos.qty * frac * targets[j].price * pos.makerFee;
          remaining -= frac;
        }
      }
    }
    if (remaining > 1e-12) realized += s * (price - pos.entry) * pos.qty * remaining - pos.qty * remaining * price * pos.takerFee;
    if (stopHit) nStop++;
    if (liquidated && s * (price - pos.entry) > 0) nLiqRebound++;
    pnls.push(realized - entryFees - funding);
    maes.push(mae);
    if (path) { if (path[path.length - 1] !== price) path.push(price); sample.push(path); }
    if ((k + 1) % 500 === 0) yield (k + 1) / p.paths;
  }

  const n = p.paths;
  return {
    provenance: "modeled",
    assumptions: describeAssumptions(p),
    paths: n,
    pLiquidation: nLiq / n,
    pLiqBeforeFirstTarget: nLiqBeforeT1 / n,
    pLiqBeforeRebound: nLiqRebound / n,
    pStop: nStop / n,
    pStopFailed: nStopFail / n,
    pTargets: nTargets.map((x) => x / n),
    expectedPnl: pnls.reduce((a, b) => a + b, 0) / n,
    pnlQuantiles: { p05: quantile(pnls, 0.05), p25: quantile(pnls, 0.25), p50: quantile(pnls, 0.5), p75: quantile(pnls, 0.75), p95: quantile(pnls, 0.95) },
    maeQuantiles: { p50: quantile(maes, 0.5), p90: quantile(maes, 0.9), p99: quantile(maes, 0.99) },
    sample,
    steps,
  };
}

/** Synchronous run (tests, workers). */
export function runMonteCarlo(pos: MCPosition, p: MCParams): MCResult {
  const it = monteCarloIter(pos, p);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

/** Chunked run that yields to the event loop between chunks — keeps the UI responsive. Same result as sync. */
export async function runMonteCarloChunked(pos: MCPosition, p: MCParams, onProgress?: (f: number) => void, signal?: AbortSignal): Promise<MCResult | null> {
  const it = monteCarloIter(pos, p);
  let r = it.next();
  while (!r.done) {
    if (signal?.aborted) return null;
    onProgress?.(r.value);
    await new Promise((res) => setTimeout(res, 0));
    r = it.next();
  }
  onProgress?.(1);
  return r.value;
}

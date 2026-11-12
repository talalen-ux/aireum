/**
 * Position planning: staggered entries, stop/target ladders, sizing from maximum risk,
 * fees, funding, slippage, liquidation and sensitivity. All outputs are MODELED.
 */
import { liquidationPrice, maxLeverageFor, crossEffectiveMargin, type ContractType, type LiqResult, type MarginMode, type PosSide, type RiskVenue } from "./exchanges";

export interface LadderLeg {
  price: number;
  /** Fraction of the position for stops/targets (sum ≤ 1); relative weight for entries (normalized). */
  weight: number;
  /** Entries: whether this leg has already filled. Unfilled legs are "pending". */
  filled?: boolean;
  /** Stops/targets: reduce-only flag (missing reduce-only can open a reverse position). */
  reduceOnly?: boolean;
}

export type SlippageFn = (side: "buy" | "sell", usd: number) => number | null;

export interface PlanInput {
  asset: "BTC" | "ETH";
  side: PosSide;
  venue: RiskVenue;
  contract: ContractType;
  marginMode: MarginMode;
  leverage: number;
  /** Maximum loss at the stop ladder, USD, all costs included. */
  maxRiskUsd: number;
  entries: LadderLeg[];
  stops: LadderLeg[];
  targets: LadderLeg[];
  makerFee: number; // fraction, e.g. 0.0002
  takerFee: number; // fraction, e.g. 0.0005
  /** Entry legs execute as maker (limit) orders; stops & liquidation always taker. */
  entryIsMaker: boolean;
  /** Funding rate per interval (fraction). Positive: longs pay shorts. */
  fundingRate: number;
  fundingIntervalHours: number;
  horizonHours: number;
  /** Fallback slippage on stop execution, bps, when no book simulator is supplied. */
  stopSlippageBps: number;
  /** Extra isolated margin added on top of initial margin (USD; coin for inverse). */
  addedMargin?: number;
  /** Cross margin: total wallet balance available (USD). */
  walletBalance?: number;
  /** Override computed size (base units). */
  qtyOverride?: number;
  /** Max account margin you are willing to post (USD). Caps size. */
  maxMarginUsd?: number;
  slippage?: SlippageFn;
}

export interface LegResult {
  price: number;
  fraction: number;
  qty: number;
  pnlUsd: number; // net of fees on that leg
  rMultiple: number | null;
}

export interface PositionPlan {
  qty: number; // base units, all entries filled
  filledQty: number; // base units, filled entries only
  avgEntry: number;
  notional: number; // USD at avg entry
  initialMargin: number; // USD (linear) — coin value converted at entry for inverse
  liq: LiqResult;
  /** Liquidation considering only already-filled entries (null if none filled). */
  liqFilledOnly: LiqResult | null;
  deltaPer100: number; // USD PnL per $100 move in the underlying
  deltaUsdPer1Pct: number;
  liqShiftPer1000Usd: number | null; // how far liq moves per $1000 extra margin
  entryFees: number;
  exitFeesAtStop: number;
  fundingCost: number; // USD over horizon (positive = cost)
  stopSlippageUsd: number;
  riskAtStopUsd: number; // total loss if full stop ladder executes, incl. costs
  perUnitRisk: number;
  avgStop: number | null;
  stopsCoverage: number; // sum of stop fractions
  targetsCoverage: number;
  stopLegs: LegResult[];
  targetLegs: LegResult[];
  /** Weighted R of the target ladder (ignores unfilled stop coverage). */
  rewardRisk: number | null;
  maxLeverageForNotional: number;
  sizingCappedBy: "risk" | "margin" | "override";
  warnings: string[];
}

const sgn = (s: PosSide) => (s === "long" ? 1 : -1);

export function weightedAvg(legs: LadderLeg[]): number | null {
  const w = legs.reduce((a, l) => a + Math.max(0, l.weight), 0);
  if (w <= 0) return null;
  return legs.reduce((a, l) => a + l.price * Math.max(0, l.weight), 0) / w;
}

/** Funding paid over horizon: s · rate · notional · intervals (positive = cost to holder). */
export function fundingCost(side: PosSide, rate: number, notional: number, intervalHours: number, horizonHours: number) {
  const intervals = intervalHours > 0 ? horizonHours / intervalHours : 0;
  return sgn(side) * rate * notional * intervals;
}

/**
 * Position size from maximum risk:
 *   qty = maxRisk / (|E − S| + entryFee·E + takerFee·S + slip·S + max(0, fundingPerUnit))
 */
export function sizeFromRisk(p: {
  side: PosSide; avgEntry: number; avgStop: number; maxRiskUsd: number; entryFeeRate: number; exitFeeRate: number; slippageBps: number;
  fundingRate: number; fundingIntervalHours: number; horizonHours: number;
}) {
  const priceRisk = sgn(p.side) * (p.avgEntry - p.avgStop);
  if (priceRisk <= 0) return { qty: 0, perUnit: NaN };
  const fundingPerUnit = Math.max(0, fundingCost(p.side, p.fundingRate, p.avgEntry, p.fundingIntervalHours, p.horizonHours));
  const perUnit = priceRisk + p.entryFeeRate * p.avgEntry + p.exitFeeRate * p.avgStop + (p.slippageBps / 1e4) * p.avgStop + fundingPerUnit;
  return { qty: p.maxRiskUsd / perUnit, perUnit };
}

export function planPosition(input: PlanInput): PositionPlan {
  const warnings: string[] = [];
  const s = sgn(input.side);
  const avgEntry = weightedAvg(input.entries);
  if (avgEntry === null) throw new Error("At least one entry leg with positive weight is required");
  const avgStop = weightedAvg(input.stops);
  const entryFeeRate = input.entryIsMaker ? input.makerFee : input.takerFee;

  // 1) slippage estimate on stop execution (prefer book simulator)
  let slipBps = input.stopSlippageBps;

  // 2) sizing
  let qty: number;
  let perUnit = NaN;
  let cappedBy: PositionPlan["sizingCappedBy"] = "risk";
  if (input.qtyOverride && input.qtyOverride > 0) {
    qty = input.qtyOverride;
    cappedBy = "override";
  } else if (avgStop !== null) {
    let r = sizeFromRisk({ side: input.side, avgEntry, avgStop, maxRiskUsd: input.maxRiskUsd, entryFeeRate, exitFeeRate: input.takerFee, slippageBps: slipBps, fundingRate: input.fundingRate, fundingIntervalHours: input.fundingIntervalHours, horizonHours: input.horizonHours });
    if (input.slippage && r.qty > 0) {
      const est = input.slippage(input.side === "long" ? "sell" : "buy", r.qty * avgStop);
      if (est !== null && Number.isFinite(est)) {
        slipBps = Math.max(0, est);
        r = sizeFromRisk({ side: input.side, avgEntry, avgStop, maxRiskUsd: input.maxRiskUsd, entryFeeRate, exitFeeRate: input.takerFee, slippageBps: slipBps, fundingRate: input.fundingRate, fundingIntervalHours: input.fundingIntervalHours, horizonHours: input.horizonHours });
      }
    }
    qty = r.qty;
    perUnit = r.perUnit;
    if (!(qty > 0)) warnings.push("Stop is on the wrong side of entry — cannot size from risk.");
  } else {
    qty = 0;
    warnings.push("No stop defined — position cannot be sized from risk.");
  }
  if (input.maxMarginUsd && input.maxMarginUsd > 0 && qty > 0) {
    const maxQty = (input.maxMarginUsd * input.leverage) / avgEntry;
    if (qty > maxQty) {
      qty = maxQty;
      cappedBy = "margin";
      warnings.push("Size capped by maximum margin; risk at stop is below the risk budget.");
    }
  }
  qty = Math.max(0, qty);

  const notional = qty * avgEntry;
  const initialMargin = input.leverage > 0 ? notional / input.leverage : notional;
  const added = input.addedMargin ?? 0;

  const marginFor = (q: number, e: number) => {
    if (input.marginMode === "cross") return crossEffectiveMargin(input.walletBalance ?? (q * e) / input.leverage);
    const im = (q * e) / input.leverage + added;
    return input.contract === "inverse" ? im / e : im; // inverse margin in coin
  };
  const liqArgs = (q: number, e: number, m: number) => ({ venue: input.venue, asset: input.asset, side: input.side, contract: input.contract, marginMode: input.marginMode, qty: q, entry: e, margin: m, closeFeeRate: input.venue === "binance" ? 0 : input.takerFee });

  const liq = qty > 0 ? liquidationPrice(liqArgs(qty, avgEntry, marginFor(qty, avgEntry))) : liquidationPrice(liqArgs(1e-9, avgEntry, 1e-9 * avgEntry));

  // liquidation with only filled entries
  const filled = input.entries.filter((l) => l.filled);
  let liqFilledOnly: LiqResult | null = null;
  let filledQty = 0;
  if (filled.length && qty > 0) {
    const totalW = input.entries.reduce((a, l) => a + Math.max(0, l.weight), 0);
    const fw = filled.reduce((a, l) => a + Math.max(0, l.weight), 0);
    filledQty = (qty * fw) / totalW;
    const fe = weightedAvg(filled)!;
    liqFilledOnly = liquidationPrice(liqArgs(filledQty, fe, marginFor(filledQty, fe)));
  }

  // liq sensitivity to added margin (isolated only)
  let liqShift: number | null = null;
  if (qty > 0 && input.marginMode === "isolated" && liq.liqPrice !== null) {
    const extra = input.contract === "inverse" ? 1000 / avgEntry : 1000;
    const l2 = liquidationPrice(liqArgs(qty, avgEntry, marginFor(qty, avgEntry) + extra));
    liqShift = l2.liqPrice !== null ? l2.liqPrice - liq.liqPrice : null;
  }

  const entryFees = notional * entryFeeRate;
  const fund = fundingCost(input.side, input.fundingRate, notional, input.fundingIntervalHours, input.horizonHours);
  const entryFeePerUnit = entryFeeRate * avgEntry;

  const legPnl = (price: number, frac: number, taker: boolean, slip: number) => {
    const q = qty * frac;
    const fillPx = price * (1 - s * slip / 1e4);
    const gross = s * (fillPx - avgEntry) * q;
    const fees = q * entryFeePerUnit + q * price * (taker ? input.takerFee : input.makerFee);
    return gross - fees - fund * frac;
  };

  const stopsCoverage = input.stops.reduce((a, l) => a + Math.max(0, l.weight), 0);
  const targetsCoverage = input.targets.reduce((a, l) => a + Math.max(0, l.weight), 0);

  const stopLegs: LegResult[] = input.stops.map((l) => ({ price: l.price, fraction: l.weight, qty: qty * l.weight, pnlUsd: legPnl(l.price, l.weight, true, slipBps), rMultiple: null }));
  const riskAtStop = -stopLegs.reduce((a, l) => a + l.pnlUsd, 0);
  const R = riskAtStop > 0 ? riskAtStop / Math.max(stopsCoverage, 1e-9) : null; // per full position
  for (const l of stopLegs) l.rMultiple = R ? l.pnlUsd / (R * l.fraction || 1) : null;
  const targetLegs: LegResult[] = input.targets.map((l) => {
    const pnl = legPnl(l.price, l.weight, false, 0);
    return { price: l.price, fraction: l.weight, qty: qty * l.weight, pnlUsd: pnl, rMultiple: R && l.weight > 0 ? pnl / (R * l.weight) : null };
  });
  const rewardRisk = R && targetsCoverage > 0 ? targetLegs.reduce((a, l) => a + l.pnlUsd, 0) / (R * Math.min(1, targetsCoverage)) : null;

  const exitFeesAtStop = input.stops.reduce((a, l) => a + qty * l.weight * l.price * input.takerFee, 0);
  const stopSlippageUsd = input.stops.reduce((a, l) => a + qty * l.weight * l.price * (slipBps / 1e4), 0);

  return {
    qty,
    filledQty,
    avgEntry,
    notional,
    initialMargin: initialMargin + added,
    liq,
    liqFilledOnly,
    deltaPer100: s * qty * 100,
    deltaUsdPer1Pct: s * notional * 0.01,
    liqShiftPer1000Usd: liqShift,
    entryFees,
    exitFeesAtStop,
    fundingCost: fund,
    stopSlippageUsd,
    riskAtStopUsd: riskAtStop,
    perUnitRisk: perUnit,
    avgStop,
    stopsCoverage,
    targetsCoverage,
    stopLegs,
    targetLegs,
    rewardRisk,
    maxLeverageForNotional: maxLeverageFor(input.venue, input.asset, notional, input.contract),
    sizingCappedBy: cappedBy,
    warnings,
  };
}

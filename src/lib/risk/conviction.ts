import { liquidationPrice, type RiskVenue } from "./exchanges";
import { marginExhaustionPrice, sign, type Dir } from "./harvest";

/**
 * ATLAS High-Conviction Futures research (linear USDT-settled contracts, paper only).
 *
 *  • Forensic card report — what a profit card visibly states vs what can only be inferred.
 *  • Profit target engine — reverse-calculates the size, notional and margin a dollar target needs.
 *  • Capital & survival matrix — per leverage: adverse room before liquidation, and the chance a
 *    position with NO edge reaches the target before being liquidated.
 *
 * Cards are selected promotional snapshots, not verified statements. A "fair price" card may be
 * an open, unrealized position. A share timestamp is not an execution timestamp.
 */

export interface ProfitCard {
  asset: string;
  venue: string;
  dir: Dir;
  leverage: number;
  pnl: number;
  roiPct: number | null;
  entry: number | null;
  ref: number | null;
  refLabel: string | null;
  shared: string; // card share timestamp (NOT execution time)
}

/** Transcribed from the user's five screenshots (references/five-profit-cards.md). Card-reported, unverified. */
export const FIVE_CARDS: ProfitCard[] = [
  { asset: "XRPUSDT", venue: "MEXC", dir: "long", leverage: 20, pnl: 213_867.1035, roiPct: 61.52, entry: 1.2947, ref: 1.3349, refLabel: "Fair Price", shared: "2026-10-28 20:56:40" },
  { asset: "NVDAUSDT", venue: "Binance Futures", dir: "short", leverage: 10, pnl: 114_388.53, roiPct: null, entry: 182.89297, ref: 174.06521, refLabel: "Average Close Price", shared: "2026-11-09 15:30:55" },
  { asset: "BTCUSDT", venue: "MEXC", dir: "short", leverage: 20, pnl: 414_558.5597, roiPct: 123.16, entry: 62_038.4, ref: 58_186.1, refLabel: "Fair Price", shared: "2026-06-25 15:59:20" },
  { asset: "ZECUSDT", venue: "MEXC", dir: "short", leverage: 20, pnl: 229_504.0582, roiPct: 374.54, entry: 513.23, ref: 417.14, refLabel: "Avg Close Price", shared: "2026-06-05 05:29:52" },
  { asset: "ETHUSDT", venue: "MEXC", dir: "short", leverage: 20, pnl: 249_881.4699, roiPct: 84.59, entry: null, ref: null, refLabel: null, shared: "2026-06-05 08:22:47" },
];

export interface CardForensics {
  card: ProfitCard;
  /** favorable move per unit, and as % of entry (observed arithmetic on visible fields) */
  move: number | null;
  movePct: number | null;
  /** INFERRED under stated assumptions */
  quantity: number | null;
  notional: number | null;
  nominalMargin: number | null;
  /** ROI the visible move implies at the stated leverage (move% × leverage) vs the ROI printed on the card */
  impliedRoiPct: number | null;
  roiGapPct: number | null;
  roiConsistent: boolean | null;
  /** margin denominator implied by PNL / ROI, when ROI is shown */
  marginFromRoi: number | null;
  /** simplified boundary — NOT a liquidation price */
  marginExhaustion: number | null;
  adverseRoomPct: number | null; // 1/leverage
  possiblyOpen: boolean;
  basis: "entry_and_reference" | "roi_only" | "insufficient";
  missing: string[];
  notes: string[];
}

const ALWAYS_MISSING = ["actual liquidation price", "maintenance-margin tier", "added collateral", "cross vs isolated margin", "worst drawdown while open (MAE)", "execution timestamps and holding period", "peak position size", "account-level return", "number of losing trades", "whether one person made all five"];

/** Reconstruct what a card implies. Assumes linear contract, constant quantity, PNL = quantity × displayed move, no fee/funding adjustment. */
export function analyzeCard(c: ProfitCard): CardForensics {
  const notes: string[] = [];
  const missing = [...ALWAYS_MISSING];
  const possiblyOpen = !!c.refLabel && /fair|mark/i.test(c.refLabel);
  if (possiblyOpen) notes.push(`"${c.refLabel}" is a mark-style price: the position may still have been open, so this PNL may be unrealized.`);
  const marginFromRoi = c.roiPct ? c.pnl / (c.roiPct / 100) : null;
  if (c.entry !== null && c.ref !== null) {
    const move = (c.ref - c.entry) * sign(c.dir);
    if (!(c.entry > 0) || !(move > 0) || !(c.leverage > 0)) {
      return { card: c, move, movePct: null, quantity: null, notional: null, nominalMargin: null, impliedRoiPct: null, roiGapPct: null, roiConsistent: null, marginFromRoi, marginExhaustion: null, adverseRoomPct: null, possiblyOpen, basis: "insufficient", missing, notes: [...notes, "Displayed entry and reference do not form a favorable move for the stated direction."] };
    }
    const movePct = (move / c.entry) * 100;
    const quantity = c.pnl / move;
    const notional = quantity * c.entry;
    const impliedRoi = movePct * c.leverage;
    const gap = c.roiPct !== null ? c.roiPct - impliedRoi : null;
    // within 3% relative: fees, funding and rounding plausibly explain the difference
    const consistent = gap !== null ? Math.abs(gap) / impliedRoi < 0.03 : null;
    if (gap !== null) notes.push(consistent ? `Printed ROI ${c.roiPct}% reconciles with move × leverage = ${impliedRoi.toFixed(2)}% (gap ${gap.toFixed(2)} pts, consistent with fees/funding).` : `Printed ROI ${c.roiPct}% does NOT reconcile with move × leverage = ${impliedRoi.toFixed(2)}% — margin was probably not notional ÷ leverage (added collateral or cross margin).`);
    if (c.roiPct === null) { missing.push("ROI"); notes.push(`ROI not shown; the visible move would imply ${impliedRoi.toFixed(1)}% on nominal margin.`); }
    return { card: c, move, movePct, quantity, notional, nominalMargin: notional / c.leverage, impliedRoiPct: impliedRoi, roiGapPct: gap, roiConsistent: consistent, marginFromRoi, marginExhaustion: marginExhaustionPrice(c.dir, c.entry, c.leverage), adverseRoomPct: 100 / c.leverage, possiblyOpen, basis: "entry_and_reference", missing, notes };
  }
  missing.push("entry price", "exit / reference price", "quantity");
  if (marginFromRoi !== null) {
    notes.push("Entry and exit are not shown. Size is inferred only from PNL ÷ ROI, which assumes ROI = PNL ÷ initial margin — more assumption-dependent than the other cards.");
    return { card: c, move: null, movePct: c.roiPct! / c.leverage, quantity: null, notional: marginFromRoi * c.leverage, nominalMargin: marginFromRoi, impliedRoiPct: null, roiGapPct: null, roiConsistent: null, marginFromRoi, marginExhaustion: null, adverseRoomPct: 100 / c.leverage, possiblyOpen, basis: "roi_only", missing, notes };
  }
  return { card: c, move: null, movePct: null, quantity: null, notional: null, nominalMargin: null, impliedRoiPct: null, roiGapPct: null, roiConsistent: null, marginFromRoi: null, marginExhaustion: null, adverseRoomPct: null, possiblyOpen, basis: "insufficient", missing, notes };
}

// ------------------------------------------------------------------ profit target engine

export interface TargetCosts {
  entryFee: number; // fraction of notional
  exitFee: number;
  slippage: number; // fraction of price on exit
  fundingPerUnit: number; // USD per unit over the hold
}

/**
 * Quantity needed to NET `target` dollars on a favorable move of `movePct`.
 * Costs scale with quantity, so the exact solution is Q = P / (net profit per unit).
 * Returns null when costs exceed the move (no size can reach the target).
 */
export function requiredQuantity(dir: Dir, entry: number, movePct: number, target: number, k: TargetCosts): { qty: number; notional: number; grossNeeded: number; costs: number; exit: number } | null {
  const d = sign(dir);
  const exit = entry * (1 + d * movePct / 100);
  const fill = exit * (1 - d * k.slippage);
  const perUnit = d * (fill - entry) - entry * k.entryFee - fill * k.exitFee - k.fundingPerUnit;
  if (!(perUnit > 0) || !(exit > 0)) return null;
  const qty = target / perUnit;
  const gross = qty * d * (exit - entry);
  return { qty, notional: qty * entry, grossNeeded: gross, costs: gross - target, exit };
}

/** Largest size a planned loss R allows with stop S: Q ≤ R / (|E−S| + per-unit costs). A planning limit, not a guaranteed maximum loss. */
export function maxQuantityForRisk(dir: Dir, entry: number, stop: number, riskUsd: number, k: TargetCosts): number {
  const d = sign(dir);
  const fill = stop * (1 - d * k.slippage);
  const perUnit = -(d * (fill - entry)) + entry * k.entryFee + fill * k.exitFee + k.fundingPerUnit;
  return perUnit > 0 ? riskUsd / perUnit : 0;
}

/**
 * Chance of reaching the target before the knock-out level for a position with NO edge
 * (price is a fair game / martingale): P = a / (a + b), a = price distance to knock-out,
 * b = price distance to target. Independent of volatility, and it makes the expected value
 * exactly zero before costs. An edge raises it; fees, funding and adverse selection lower it.
 */
export function noEdgeSurvival(entry: number, target: number, knockout: number): number | null {
  if (!(entry > 0) || !(target > 0) || !(knockout > 0)) return null;
  const a = Math.abs(knockout - entry), b = Math.abs(target - entry);
  return a + b > 0 ? a / (a + b) : null;
}

export interface MatrixRow {
  leverage: number;
  qty: number;
  notional: number;
  nominalMargin: number;
  costs: number;
  exit: number;
  marginExhaustion: number; // simplified boundary, NOT liquidation
  liqPrice: number | null; // venue-tier estimate; null = unknown or none
  liqKnown: boolean;
  adverseRoomPct: number | null; // entry → knock-out (liq if known, else exhaustion)
  pTargetBeforeKnockout: number | null; // no-edge
  lossIfKnockedOut: number; // ≈ nominal margin
  /** share of visible ±100bp book depth this notional represents (null when no live book) */
  depthShare: number | null;
  fundable: boolean | null; // nominal margin ≤ stated capital
  withinBudget: boolean | null; // loss at knock-out ≤ remaining loss budget
  flags: string[];
}

export interface MatrixInput {
  dir: Dir;
  asset: string;
  venue: string;
  entry: number;
  movePct: number;
  target: number;
  leverages: number[];
  costs: TargetCosts;
  capitalUsd: number | null;
  remainingBudgetUsd: number | null;
  /** aggregate resting USD within ±100bp on the side the ENTRY would consume */
  depthUsd: number | null;
}

export function survivalMatrix(inp: MatrixInput): { rows: MatrixRow[]; req: ReturnType<typeof requiredQuantity> } {
  const req = requiredQuantity(inp.dir, inp.entry, inp.movePct, inp.target, inp.costs);
  if (!req) return { rows: [], req };
  const supported = ["binance", "bybit", "okx"].includes(inp.venue) && (inp.asset === "BTC" || inp.asset === "ETH");
  const rows = inp.leverages.map((L) => {
    const margin = req.notional / L;
    const exhaustion = marginExhaustionPrice(inp.dir, inp.entry, L);
    let liq: number | null = null;
    if (supported) liq = liquidationPrice({ venue: inp.venue as RiskVenue, asset: inp.asset as "BTC" | "ETH", side: inp.dir, contract: "linear", marginMode: "isolated", qty: req.qty, entry: inp.entry, margin }).liqPrice;
    const knock = liq ?? exhaustion;
    const room = Math.abs(knock - inp.entry) / inp.entry * 100;
    const flags: string[] = [];
    const depthShare = inp.depthUsd && inp.depthUsd > 0 ? req.notional / inp.depthUsd : null;
    if (depthShare !== null && depthShare > 0.25) flags.push(`Entry is ${(depthShare * 100).toFixed(0)}% of visible ±100bp depth — would move the market; not executable at the quoted price.`);
    const fundable = inp.capitalUsd !== null ? margin <= inp.capitalUsd : null;
    if (fundable === false) flags.push("Nominal margin exceeds stated capital.");
    const withinBudget = inp.remainingBudgetUsd !== null ? margin <= inp.remainingBudgetUsd : null;
    if (withinBudget === false) flags.push("A knock-out would exceed the remaining loss budget.");
    if (L >= 50) flags.push("Extreme leverage: normal intraday noise can reach the knock-out level.");
    if (room < inp.movePct) flags.push("Knock-out is closer than the target: the trade is more likely to be liquidated than to pay, absent an edge.");
    return { leverage: L, qty: req.qty, notional: req.notional, nominalMargin: margin, costs: req.costs, exit: req.exit, marginExhaustion: exhaustion, liqPrice: liq, liqKnown: supported, adverseRoomPct: room, pTargetBeforeKnockout: noEdgeSurvival(inp.entry, req.exit, knock), lossIfKnockedOut: margin, depthShare, fundable, withinBudget, flags };
  });
  return { rows, req };
}

export const REFERENCE_TARGETS = [100_000, 200_000, 250_000, 400_000];

/** Expected value per attempt with no edge: p·target − (1−p)·margin. Shows that leverage reshapes the bet, it does not improve it. */
export function noEdgeExpectancy(r: MatrixRow, target: number): number | null {
  return r.pTargetBeforeKnockout === null ? null : r.pTargetBeforeKnockout * target - (1 - r.pTargetBeforeKnockout) * r.lossIfKnockedOut;
}

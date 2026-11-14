import { gaussian, mulberry32 } from "../core/stats";
import { liquidationPrice, type RiskVenue } from "./exchanges";

/**
 * ATLAS Futures Profit Harvesting (linear USDT-margined contracts).
 *
 *  Strategy A — Core position + partial profit harvesting: one position, reduce-only
 *               scale-outs at precomputed milestones. The open remainder can erase
 *               harvested gains, so combined (realized + unrealized) PnL is always shown.
 *  Strategy B — Independent fixed-net-profit trades: each trade closes fully at a net
 *               dollar target, returns to flat, and needs a fresh edge assessment.
 *
 * Notation: q quantity (base), E average entry, X executable exit, d = +1 long / −1 short,
 * fe / fx entry / exit fee rates, s slippage (fraction of price, always adverse).
 * Everything here is SIMULATION / planning math. Nothing routes orders.
 */

export type Dir = "long" | "short";
export const sign = (d: Dir) => (d === "long" ? 1 : -1);

export interface Costs {
  entryFee: number; // fraction, e.g. 0.0006
  exitFee: number;
  /** adverse slippage on each exit, as a fraction of price (0.0001 = 1bp) */
  slippage: number;
  /** funding paid (+) or received (−) per unit of base over the intended hold, in USD */
  fundingPerUnit: number;
}

export const NO_COSTS: Costs = { entryFee: 0, exitFee: 0, slippage: 0, fundingPerUnit: 0 };

/** Gross realized PnL on closed quantity c: d·c·(X − E). */
export function grossPnl(d: Dir, c: number, E: number, X: number) {
  return sign(d) * c * (X - E);
}

/**
 * Net realized PnL on closed quantity c exiting at quoted price X.
 * Slippage moves the fill against you: long sells at X·(1−s), short buys at X·(1+s).
 * Fees: entry fee allocated pro-rata (c·E·fe), exit fee on the filled notional.
 */
export function netClosedPnl(d: Dir, c: number, E: number, X: number, k: Costs): number {
  const fill = X * (1 - sign(d) * k.slippage);
  return grossPnl(d, c, E, fill) - c * E * k.entryFee - c * fill * k.exitFee - c * k.fundingPerUnit;
}

/**
 * Quoted exit price that nets exactly T dollars on quantity c (inverse of netClosedPnl).
 *   long : X = (T/c + E(1+fe) + F) / ((1−s)(1−fx))
 *   short: X = (E(1−fe) − T/c − F) / ((1+s)(1+fx))
 */
export function exitForNetTarget(d: Dir, c: number, E: number, T: number, k: Costs): number | null {
  if (!(c > 0) || !(E > 0)) return null;
  const x = d === "long"
    ? (T / c + E * (1 + k.entryFee) + k.fundingPerUnit) / ((1 - k.slippage) * (1 - k.exitFee))
    : (E * (1 - k.entryFee) - T / c - k.fundingPerUnit) / ((1 + k.slippage) * (1 + k.exitFee));
  return x > 0 ? x : null;
}

/** Net loss (positive number) if the whole quantity q is stopped at trigger S. `gapBps` models a stop-market fill worse than its trigger. */
export function stopLoss(d: Dir, q: number, E: number, S: number, k: Costs, gapBps = 0): number {
  const kk = { ...k, slippage: k.slippage + gapBps / 10_000 };
  return -netClosedPnl(d, q, E, S, kk);
}

/** Margin exhaustion at E·(1 ∓ 1/L). NOT an exchange liquidation price — shown only to make that distinction explicit. */
export function marginExhaustionPrice(d: Dir, E: number, leverage: number) {
  return E * (1 - sign(d) / leverage);
}

// ------------------------------------------------------------------ risk budget

export interface RiskBudget {
  cumulativeLossLimitUsd: number | null;
  realizedLossesUsd: number | null;
  otherOpenRiskUsd: number | null;
}

export interface BudgetView {
  remaining: number | null; // null = unknown → must not be treated as fully available
  known: boolean;
  exhausted: boolean;
  note: string;
}

/** remaining = limit − realized losses − other committed risk. Losses never reset (a liquidation is not a reset). */
export function remainingBudget(b: RiskBudget): BudgetView {
  if (b.cumulativeLossLimitUsd === null || b.realizedLossesUsd === null) {
    return { remaining: null, known: false, exhausted: false, note: "Loss limit or realized losses unknown — remaining budget cannot be assumed available." };
  }
  const r = b.cumulativeLossLimitUsd - Math.max(0, b.realizedLossesUsd) - Math.max(0, b.otherOpenRiskUsd ?? 0);
  return { remaining: r, known: true, exhausted: r <= 0, note: r <= 0 ? "Cumulative loss budget exhausted — no new risk." : b.otherOpenRiskUsd === null ? "Other open risk not provided; treated as 0 (may overstate what is available)." : "" };
}

/** Apply a closed trade's net PnL to the budget. Only losses consume budget; wins do not refill it. */
export function applyResult(b: RiskBudget, netPnlUsd: number): RiskBudget {
  if (netPnlUsd >= 0 || b.realizedLossesUsd === null) return b;
  return { ...b, realizedLossesUsd: b.realizedLossesUsd - netPnlUsd };
}

// ------------------------------------------------------------------ Strategy A

export type LadderMode = "fixed_qty" | "fixed_net_usd" | "percent" | "price_levels";

export interface HarvestInput {
  dir: Dir;
  qty: number;
  entry: number;
  stop: number;
  costs: Costs;
  mode: LadderMode;
  steps: number;
  /** fixed_qty: base qty per exit · fixed_net_usd: net $ per exit · percent: % of ORIGINAL qty per exit */
  stepValue: number;
  /** price distance between exits, used by fixed_qty / percent modes (USD) */
  stepDistance: number;
  /** price_levels mode: explicit exits */
  levels?: { price: number; qty: number }[];
  /** residual policy: what is left after the ladder still runs to the stop unless closed */
  stopGapBps?: number;
}

export interface HarvestRow {
  i: number;
  price: number;
  qty: number; // closed at this exit
  netUsd: number; // net realized on this exit
  cumRealized: number;
  remainingQty: number;
  /** combined PnL right at this exit: realized so far + net unrealized on the remainder at this price */
  combinedHere: number;
  /** combined PnL if the remainder is then stopped out (worst planned case after this harvest) */
  combinedIfStopped: number;
  /** price at which the remainder's loss erases everything harvested so far */
  giveBackPrice: number | null;
  exposurePct: number; // remaining / original
}

export interface HarvestPlan {
  rows: HarvestRow[];
  issues: { level: "critical" | "warning"; text: string }[];
  totalLadderQty: number;
  residualQty: number;
  riskAtEntry: number; // net loss if the full position is stopped
  bestCase: number; // all exits fill, residual closed at last exit price
  notional: number;
}

/** Net unrealized PnL on remaining quantity at mark (as if closed there, costs included). */
export function netUnrealized(d: Dir, rem: number, E: number, mark: number, k: Costs) {
  return rem > 0 ? netClosedPnl(d, rem, E, mark, k) : 0;
}

export function planHarvest(inp: HarvestInput): HarvestPlan {
  const { dir, qty: q, entry: E, stop: S, costs: k } = inp;
  const d = sign(dir);
  const issues: HarvestPlan["issues"] = [];
  const exits: { price: number; qty: number }[] = [];

  if (inp.mode === "price_levels") {
    for (const l of inp.levels ?? []) exits.push({ price: l.price, qty: l.qty });
  } else if (inp.mode === "fixed_net_usd") {
    // exits at evenly spaced prices; each quantity is solved so that exit nets exactly `stepValue`
    for (let i = 1; i <= inp.steps; i++) {
      const price = E + d * inp.stepDistance * i;
      const perUnit = netClosedPnl(dir, 1, E, price, k);
      if (perUnit <= 0) { issues.push({ level: "critical", text: `Exit ${price.toFixed(1)} cannot net a profit after costs (step smaller than round-trip costs).` }); continue; }
      exits.push({ price, qty: inp.stepValue / perUnit });
    }
  } else {
    const c = inp.mode === "fixed_qty" ? inp.stepValue : (q * inp.stepValue) / 100;
    for (let i = 1; i <= inp.steps; i++) exits.push({ price: E + d * inp.stepDistance * i, qty: c });
  }

  // ---- validation (reduce-only coverage, direction, stop side)
  const total = exits.reduce((a, e) => a + e.qty, 0);
  if (total > q + 1e-12) issues.push({ level: "critical", text: `Take-profit quantities (${total.toFixed(4)}) exceed the open quantity (${q.toFixed(4)}). Reduce-only orders beyond the position would be rejected or flip it.` });
  for (const e of exits) if (d * (e.price - E) <= 0) issues.push({ level: "critical", text: `Exit ${e.price.toFixed(1)} is not on the profit side of entry.` });
  if (d * (S - E) >= 0) issues.push({ level: "critical", text: "Stop is on the profit side of entry — it does not protect the position." });
  if (exits.some((e) => !(e.qty > 0))) issues.push({ level: "critical", text: "Exit with non-positive quantity." });

  // ---- walk the ladder (clamped so the simulation itself can never over-close)
  const rows: HarvestRow[] = [];
  let rem = q, cum = 0;
  exits.sort((a, b) => d * (a.price - b.price));
  exits.forEach((e, i) => {
    const c = Math.min(e.qty, rem);
    if (c <= 0) return;
    const net = netClosedPnl(dir, c, E, e.price, k);
    cum += net;
    rem -= c;
    const stopped = rem > 1e-12 ? -stopLoss(dir, rem, E, S, k, inp.stopGapBps ?? 0) : 0;
    // price where net unrealized on remainder == −cum  (ignoring slippage non-linearity it is linear in price)
    let giveBack: number | null = null;
    if (rem > 1e-12) {
      const u0 = netUnrealized(dir, rem, E, E, k), u1 = netUnrealized(dir, rem, E, E + d, k);
      const slope = u1 - u0; // per $1 in the favorable direction
      giveBack = slope !== 0 ? E + d * ((-cum - u0) / slope) : null;
    }
    rows.push({ i: i + 1, price: e.price, qty: c, netUsd: net, cumRealized: cum, remainingQty: rem, combinedHere: cum + netUnrealized(dir, rem, E, e.price, k), combinedIfStopped: cum + stopped, giveBackPrice: giveBack, exposurePct: rem / q });
  });
  if (rows.some((r) => r.netUsd <= 0)) issues.push({ level: "warning", text: "At least one exit nets ≤ $0 after fees — the price step is smaller than round-trip costs." });
  const last = rows.at(-1);
  if (last && last.combinedIfStopped < 0 && last.remainingQty > 1e-12) issues.push({ level: "warning", text: `After the full ladder, a stop-out of the remaining ${last.remainingQty.toFixed(4)} still leaves the trade net negative (${last.combinedIfStopped.toFixed(0)} USD). Harvested gains do not cover the residual risk.` });

  return {
    rows, issues, totalLadderQty: total, residualQty: Math.max(0, q - total),
    riskAtEntry: stopLoss(dir, q, E, S, k, inp.stopGapBps ?? 0),
    bestCase: last ? last.combinedHere : 0,
    notional: q * E,
  };
}

// ------------------------------------------------------------------ Strategy B

export interface MicroInput {
  dir: Dir;
  entry: number;
  stop: number;
  netTargetUsd: number;
  costs: Costs;
  /** size from this per-attempt risk (net loss at stop) … */
  maxRiskUsd: number;
  /** … or use an explicit quantity */
  qty?: number;
  stopGapBps?: number;
}

export interface MicroPlan {
  qty: number;
  exit: number | null;
  requiredMove: number | null; // favorable price move for the net target
  requiredMoveBps: number | null;
  grossAtExit: number | null; // gross $ needed to net the target
  costPerRoundTrip: number | null; // fees + slippage + funding at the target exit
  costShareOfGross: number | null;
  lossAtStop: number; // net loss per losing trade (positive)
  breakevenWinRate: number | null; // L/(T+L)
  rewardRisk: number | null;
  notional: number;
  issues: { level: "critical" | "warning"; text: string }[];
}

export function planMicro(inp: MicroInput): MicroPlan {
  const { dir, entry: E, stop: S, costs: k } = inp;
  const d = sign(dir);
  const issues: MicroPlan["issues"] = [];
  if (d * (S - E) >= 0) issues.push({ level: "critical", text: "Stop is on the profit side of entry." });
  // size from risk: loss per unit at stop (net, incl. costs)
  const perUnit = stopLoss(dir, 1, E, S, k, inp.stopGapBps ?? 0);
  const qty = inp.qty ?? (perUnit > 0 ? inp.maxRiskUsd / perUnit : 0);
  const exit = qty > 0 ? exitForNetTarget(dir, qty, E, inp.netTargetUsd, k) : null;
  const lossAtStop = qty > 0 ? stopLoss(dir, qty, E, S, k, inp.stopGapBps ?? 0) : 0;
  const gross = exit !== null ? grossPnl(dir, qty, E, exit) : null;
  const move = exit !== null ? d * (exit - E) : null;
  if (qty <= 0) issues.push({ level: "critical", text: "Cannot size the trade: risk per unit at the stop is not positive." });
  const be = lossAtStop > 0 && inp.netTargetUsd > 0 ? lossAtStop / (inp.netTargetUsd + lossAtStop) : null;
  if (be !== null && be > 0.7) issues.push({ level: "warning", text: `Needs a ${(be * 100).toFixed(1)}% win rate just to break even — a high hit rate alone would not make this profitable.` });
  return {
    qty, exit, requiredMove: move, requiredMoveBps: move !== null ? (move / E) * 10_000 : null,
    grossAtExit: gross, costPerRoundTrip: gross !== null ? gross - inp.netTargetUsd : null,
    costShareOfGross: gross !== null && gross > 0 ? (gross - inp.netTargetUsd) / gross : null,
    lossAtStop, breakevenWinRate: be, rewardRisk: lossAtStop > 0 ? inp.netTargetUsd / lossAtStop : null,
    notional: qty * E, issues,
  };
}

// ------------------------------------------------------------------ liquidation safety

export interface LiqCheck {
  liqPrice: number | null;
  known: boolean; // false → precise liquidation suppressed
  bufferPct: number | null; // distance mark→liq
  stopBeyondLiq: boolean;
  exhaustion: number;
  note: string;
}

/**
 * Venue liquidation estimate. If the venue has no maintenance-tier table here, the precise
 * figure is SUPPRESSED (unknown) rather than approximated with the margin-exhaustion shortcut.
 */
export function liquidationCheck(p: { venue: string; asset: "BTC" | "ETH"; dir: Dir; qty: number; entry: number; leverage: number; stop: number; mark: number | null; addedMargin?: number }): LiqCheck {
  const exhaustion = marginExhaustionPrice(p.dir, p.entry, p.leverage);
  const supported = p.venue === "binance" || p.venue === "bybit" || p.venue === "okx";
  if (!supported || !(p.qty > 0)) {
    return { liqPrice: null, known: false, bufferPct: null, stopBeyondLiq: false, exhaustion, note: supported ? "No position size." : `No maintenance-margin tiers for ${p.venue} — liquidation price unknown. Use the venue's displayed estimate.` };
  }
  const margin = (p.qty * p.entry) / p.leverage + (p.addedMargin ?? 0);
  const r = liquidationPrice({ venue: p.venue as RiskVenue, asset: p.asset, side: p.dir, contract: "linear", marginMode: "isolated", qty: p.qty, entry: p.entry, margin });
  const liq = r.liqPrice;
  const d = sign(p.dir);
  const stopBeyondLiq = liq !== null && d * (p.stop - liq) <= 0; // long: stop ≤ liq · short: stop ≥ liq
  return {
    liqPrice: liq, known: true,
    bufferPct: liq !== null && p.mark ? Math.abs(p.mark - liq) / p.mark : null,
    stopBeyondLiq, exhaustion,
    note: stopBeyondLiq ? "UNSAFE: the venue would liquidate before the stop can trigger." : liq === null ? "Over-collateralized: no liquidation in this direction." : "Estimate from transcribed tiers — verify against the venue.",
  };
}

// ------------------------------------------------------------------ feed freshness

export type DataQuality = "verified" | "degraded" | "unavailable";

/** A stale or missing feed can never be labeled live. */
export function feedQuality(mode: "live" | "simulation" | "replay", ageMs: number | null, liveFeeds: number): { quality: DataQuality; live: boolean; note: string } {
  if (ageMs === null || liveFeeds === 0) return { quality: "unavailable", live: false, note: "No price feed." };
  if (mode !== "live") return { quality: "degraded", live: false, note: `${mode.toUpperCase()} data — not a live market.` };
  if (ageMs > 5000) return { quality: "degraded", live: false, note: `Price is ${(ageMs / 1000).toFixed(1)}s old — stale.` };
  return { quality: "verified", live: true, note: `${liveFeeds} live feed(s), ${ageMs.toFixed(0)}ms old.` };
}

// ------------------------------------------------------------------ A vs B at identical capital-at-risk

export interface CompareInput {
  dir: Dir;
  entry: number;
  stop: number;
  costs: Costs;
  /** identical maximum planned dollar loss for A (whole position) and for each B attempt */
  riskUsd: number;
  harvest: Omit<HarvestInput, "dir" | "entry" | "stop" | "costs" | "qty">;
  netTargetUsd: number;
  /** B: maximum attempts inside the horizon, and bars to wait after each close */
  maxTrades: number;
  cooldownBars: number;
  /** path assumptions (HYPOTHETICAL): per-bar volatility as a fraction, drift per bar in the trade direction (0 = no edge) */
  volPerBar: number;
  driftPerBar: number;
  bars: number;
  paths: number;
  seed: number;
  stopGapBps: number;
  /** stop B for the session once cumulative loss reaches this (defaults to riskUsd → same total budget as A) */
  sessionLossLimitUsd?: number;
}

export interface StratStats {
  ev: number; // mean net PnL per path
  median: number;
  winRate: number; // share of paths with net > 0
  avgWin: number;
  avgLoss: number;
  profitFactor: number | null;
  worst: number;
  cvar5: number; // mean of worst 5%
  maxDrawdownAvg: number; // average peak-to-trough of combined equity within a path
  trades: number; // avg entries per path
  feesAvg: number;
  timeInMarket: number;
  ruinRate: number; // share of paths that lost ≥ the session loss limit
}

export interface CompareResult {
  a: StratStats;
  b: StratStats;
  /** benchmark: same entry/stop/size as A, no harvesting, hold to stop or horizon */
  hold: StratStats;
  qtyA: number;
  qtyB: number;
  bTradeWinRate: number | null; // per-trade hit rate of B
  bBreakeven: number | null;
  assumptions: string[];
  samples: { a: number[]; b: number[] }; // equity paths (first few) for plotting
}

function summarize(pnls: number[], dds: number[], trades: number[], fees: number[], tim: number[], limit: number): StratStats {
  const n = pnls.length;
  const s = [...pnls].sort((x, y) => x - y);
  const wins = pnls.filter((x) => x > 0), losses = pnls.filter((x) => x <= 0);
  const sum = (v: number[]) => v.reduce((a, b) => a + b, 0);
  const k = Math.max(1, Math.floor(n * 0.05));
  const gl = -sum(losses);
  return {
    ev: sum(pnls) / n, median: s[Math.floor(n / 2)], winRate: wins.length / n,
    avgWin: wins.length ? sum(wins) / wins.length : 0, avgLoss: losses.length ? sum(losses) / losses.length : 0,
    profitFactor: gl > 0 ? sum(wins) / gl : null, worst: s[0], cvar5: sum(s.slice(0, k)) / k,
    maxDrawdownAvg: sum(dds) / n, trades: sum(trades) / n, feesAvg: sum(fees) / n, timeInMarket: sum(tim) / n,
    ruinRate: pnls.filter((x) => x <= -limit).length / n,
  };
}

/**
 * Monte-Carlo comparison on the SAME simulated price paths. Both strategies risk the same
 * dollars per position (A once; B per attempt, capped by the same session loss limit).
 * With driftPerBar = 0 there is no edge by construction, so expected value ≈ −costs for both:
 * frequent small wins do not create positive expectancy.
 */
export function compareStrategies(c: CompareInput): CompareResult {
  const d = sign(c.dir);
  const E = c.entry;
  const stopDist = Math.abs(E - c.stop);
  const perUnit = stopLoss(c.dir, 1, E, c.stop, c.costs, c.stopGapBps);
  const qty = perUnit > 0 ? c.riskUsd / perUnit : 0;
  const planA = planHarvest({ ...c.harvest, dir: c.dir, entry: E, stop: c.stop, costs: c.costs, qty, stopGapBps: c.stopGapBps });
  const limit = c.sessionLossLimitUsd ?? c.riskUsd;
  const rand = mulberry32(c.seed);
  const A: number[] = [], B: number[] = [], H: number[] = [];
  const ddA: number[] = [], ddB: number[] = [], ddH: number[] = [];
  const trA: number[] = [], trB: number[] = [], trH: number[] = [];
  const feA: number[] = [], feB: number[] = [], feH: number[] = [];
  const tiA: number[] = [], tiB: number[] = [], tiH: number[] = [];
  let bWins = 0, bTrades = 0;
  const samples = { a: [] as number[], b: [] as number[] };
  const feeOf = (q: number, e: number, x: number) => q * e * c.costs.entryFee + q * x * c.costs.exitFee;

  for (let p = 0; p < c.paths; p++) {
    // one shared path: bar highs/lows approximated by open/close extremes
    const px: number[] = [E];
    for (let i = 1; i <= c.bars; i++) px.push(px[i - 1] * Math.exp(d * c.driftPerBar + c.volPerBar * gaussian(rand)));

    // ---- A: harvest ladder
    {
      let rem = qty, real = 0, peak = 0, dd = 0, fee = 0, inMkt = 0, next = 0;
      for (let i = 1; i <= c.bars && rem > 1e-12; i++) {
        inMkt++;
        const lo = Math.min(px[i - 1], px[i]), hi = Math.max(px[i - 1], px[i]);
        const stopHit = c.dir === "long" ? lo <= c.stop : hi >= c.stop;
        if (stopHit) { real -= stopLoss(c.dir, rem, E, c.stop, c.costs, c.stopGapBps); fee += feeOf(rem, E, c.stop); rem = 0; }
        else {
          while (next < planA.rows.length && (c.dir === "long" ? hi >= planA.rows[next].price : lo <= planA.rows[next].price)) {
            const r = planA.rows[next++];
            const q = Math.min(r.qty, rem);
            real += netClosedPnl(c.dir, q, E, r.price, c.costs); fee += feeOf(q, E, r.price); rem -= q;
          }
        }
        const eq = real + netUnrealized(c.dir, rem, E, px[i], c.costs);
        peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
        if (p === 0) samples.a.push(eq);
      }
      if (rem > 1e-12) { real += netClosedPnl(c.dir, rem, E, px[c.bars], c.costs); fee += feeOf(rem, E, px[c.bars]); }
      A.push(real); ddA.push(dd); trA.push(1); feA.push(fee); tiA.push(inMkt / c.bars);
    }

    // ---- hold benchmark (no harvest)
    {
      let real = 0, open = true, peak = 0, dd = 0, inMkt = 0, fee = 0;
      for (let i = 1; i <= c.bars && open; i++) {
        inMkt++;
        const lo = Math.min(px[i - 1], px[i]), hi = Math.max(px[i - 1], px[i]);
        if (c.dir === "long" ? lo <= c.stop : hi >= c.stop) { real = -stopLoss(c.dir, qty, E, c.stop, c.costs, c.stopGapBps); fee = feeOf(qty, E, c.stop); open = false; }
        const eq = open ? netUnrealized(c.dir, qty, E, px[i], c.costs) : real;
        peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
      }
      if (open) { real = netClosedPnl(c.dir, qty, E, px[c.bars], c.costs); fee = feeOf(qty, E, px[c.bars]); }
      H.push(real); ddH.push(dd); trH.push(1); feH.push(fee); tiH.push(inMkt / c.bars);
    }

    // ---- B: independent fixed-net trades, re-entering at the then-current price with the same stop distance and risk
    {
      let real = 0, peak = 0, dd = 0, fee = 0, inMkt = 0, n = 0, i = 1;
      while (i <= c.bars && n < c.maxTrades && real > -limit) {
        const e = px[i - 1];
        const s = e - d * stopDist;
        const pu = stopLoss(c.dir, 1, e, s, c.costs, c.stopGapBps);
        const q = pu > 0 ? c.riskUsd / pu : 0;
        const x = exitForNetTarget(c.dir, q, e, c.netTargetUsd, c.costs);
        if (!(q > 0) || x === null) break;
        n++; bTrades++;
        let closed = false;
        for (; i <= c.bars && !closed; i++) {
          inMkt++;
          const lo = Math.min(px[i - 1], px[i]), hi = Math.max(px[i - 1], px[i]);
          if (c.dir === "long" ? lo <= s : hi >= s) { real -= stopLoss(c.dir, q, e, s, c.costs, c.stopGapBps); fee += feeOf(q, e, s); closed = true; }
          else if (c.dir === "long" ? hi >= x : lo <= x) { real += c.netTargetUsd; fee += feeOf(q, e, x); closed = true; bWins++; }
          const eq = closed ? real : real + netUnrealized(c.dir, q, e, px[i], c.costs);
          peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq);
          if (p === 0) samples.b.push(eq);
        }
        if (!closed) { real += netClosedPnl(c.dir, q, e, px[c.bars], c.costs); fee += feeOf(q, e, px[c.bars]); }
        i += c.cooldownBars;
      }
      B.push(real); ddB.push(dd); trB.push(n); feB.push(fee); tiB.push(inMkt / c.bars);
    }
  }
  const micro = planMicro({ dir: c.dir, entry: E, stop: c.stop, netTargetUsd: c.netTargetUsd, costs: c.costs, maxRiskUsd: c.riskUsd, stopGapBps: c.stopGapBps });
  return {
    a: summarize(A, ddA, trA, feA, tiA, limit), b: summarize(B, ddB, trB, feB, tiB, limit), hold: summarize(H, ddH, trH, feH, tiH, limit),
    qtyA: qty, qtyB: micro.qty, bTradeWinRate: bTrades ? bWins / bTrades : null, bBreakeven: micro.breakevenWinRate,
    assumptions: [
      `HYPOTHETICAL paths: geometric random walk, ${(c.volPerBar * 100).toFixed(3)}% volatility per bar, drift ${(c.driftPerBar * 1e4).toFixed(2)}bp per bar in the trade direction${c.driftPerBar === 0 ? " (no edge assumed)" : " (an ASSUMED edge — not measured)"}.`,
      `Identical capital-at-risk: A risks $${c.riskUsd.toFixed(0)} once; B risks $${c.riskUsd.toFixed(0)} per attempt and stops for the session at −$${limit.toFixed(0)}.`,
      `B re-enters in the same direction after ${c.cooldownBars} bar(s) with no fresh signal — in practice each re-entry needs its own edge assessment.`,
      "Stops fill at trigger plus the configured gap; no liquidation, queue position, outages or funding spikes are modeled.",
    ],
    samples,
  };
}

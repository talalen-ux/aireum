/**
 * Pre-trade and live-position risk checks. Each check is deterministic and explainable.
 */
import type { PlanInput, PositionPlan } from "./position";

export type Severity = "critical" | "warning" | "info";

export interface RiskCheck {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
}

export interface CheckOptions {
  /** Average true range in price units, for buffer checks. */
  atr?: number | null;
  /** Minimum stop-to-liquidation buffer in ATR multiples. */
  minAtrBuffer?: number;
  /** Current mark price, for distance-to-liquidation context. */
  mark?: number | null;
}

export function runChecks(input: PlanInput, plan: PositionPlan, opts: CheckOptions = {}): RiskCheck[] {
  const out: RiskCheck[] = [];
  const long = input.side === "long";
  const liq = plan.liq.liqPrice;
  const atr = opts.atr ?? null;
  const minBuf = opts.minAtrBuffer ?? 1;

  if (!input.stops.length) {
    out.push({ id: "no_stop", severity: "critical", title: "No stop-loss", detail: "Loss is bounded only by liquidation. Risk cannot be sized." });
  }

  for (const st of input.stops) {
    if (long ? st.price >= plan.avgEntry : st.price <= plan.avgEntry) {
      out.push({ id: "stop_wrong_side", severity: "critical", title: "Stop on wrong side of entry", detail: `Stop ${st.price} would trigger immediately for a ${input.side}.` });
    }
    if (liq !== null) {
      const beyond = long ? st.price <= liq : st.price >= liq;
      if (beyond) {
        out.push({
          id: "stop_beyond_liq",
          severity: "critical",
          title: long ? "Stop below liquidation" : "Stop above liquidation",
          detail: `Stop ${st.price.toFixed(1)} is beyond liquidation ${liq.toFixed(1)} (mark-triggered). The stop can never execute; liquidation happens first.`,
        });
      } else if (atr && atr > 0 && Math.abs(st.price - liq) < minBuf * atr) {
        out.push({
          id: "stop_near_liq",
          severity: "warning",
          title: "Stop too close to liquidation",
          detail: `Buffer ${Math.abs(st.price - liq).toFixed(1)} < ${minBuf}×ATR (${(minBuf * atr).toFixed(1)}). A mark/last divergence or a gap can liquidate before the stop fills.`,
        });
      }
    }
    if (st.reduceOnly === false) {
      out.push({ id: "stop_not_reduce_only", severity: "warning", title: "Stop not reduce-only", detail: `Stop at ${st.price} could open a reverse position if the position was already reduced.` });
    }
  }

  if (input.stops.length && plan.stopsCoverage < 0.999) {
    const unc = (1 - plan.stopsCoverage) * plan.qty;
    out.push({ id: "uncovered_qty", severity: "critical", title: "Uncovered quantity", detail: `${(100 * (1 - plan.stopsCoverage)).toFixed(0)}% of the position (${unc.toFixed(4)} ${input.asset}) has no stop.` });
  }
  if (plan.stopsCoverage > 1.001) {
    out.push({ id: "stops_exceed", severity: "warning", title: "Stops exceed position", detail: `Stop ladder covers ${(100 * plan.stopsCoverage).toFixed(0)}% of size; excess could flip the position unless reduce-only.` });
  }
  if (plan.targetsCoverage > 1.001) {
    out.push({ id: "targets_exceed", severity: "warning", title: "Target ladder exceeds position", detail: `Targets cover ${(100 * plan.targetsCoverage).toFixed(0)}% of size.` });
  }
  for (const t of input.targets) {
    if (long ? t.price <= plan.avgEntry : t.price >= plan.avgEntry) {
      out.push({ id: "target_wrong_side", severity: "warning", title: "Target on wrong side of entry", detail: `Target ${t.price} realizes a loss.` });
    }
    if (t.reduceOnly === false) out.push({ id: "target_not_reduce_only", severity: "warning", title: "Target not reduce-only", detail: `Target at ${t.price} is not reduce-only.` });
  }

  // pending entries that push liquidation past the stop
  const pending = input.entries.filter((e) => !e.filled);
  if (pending.length && plan.liqFilledOnly?.liqPrice != null && liq !== null && plan.avgStop !== null) {
    const nowOk = long ? plan.avgStop > plan.liqFilledOnly.liqPrice : plan.avgStop < plan.liqFilledOnly.liqPrice;
    const afterBad = long ? plan.avgStop <= liq : plan.avgStop >= liq;
    if (nowOk && afterBad) {
      out.push({ id: "pending_pushes_liq", severity: "critical", title: "Pending entries push liquidation past stop", detail: `If all pending entries fill, liquidation moves from ${plan.liqFilledOnly.liqPrice.toFixed(1)} to ${liq.toFixed(1)}, beyond the stop.` });
    }
  }
  if (pending.length && input.marginMode === "cross") {
    out.push({ id: "pending_cross", severity: "info", title: "Pending entries share cross collateral", detail: "Fills will consume shared wallet margin and move every cross position's liquidation." });
  }

  if (input.leverage > plan.maxLeverageForNotional) {
    out.push({ id: "leverage_tier", severity: "critical", title: "Leverage exceeds tier maximum", detail: `${input.leverage}× requested; the venue tier for this notional allows ${plan.maxLeverageForNotional}×. The order would be rejected or margin increased.` });
  }

  if (liq !== null && opts.mark) {
    const dist = Math.abs(opts.mark - liq) / opts.mark;
    if (dist < 0.02) out.push({ id: "liq_close", severity: "warning", title: "Liquidation within 2% of mark", detail: `Distance ${(dist * 100).toFixed(2)}%. Normal intraday volatility can reach this.` });
    if (atr && atr > 0 && Math.abs(opts.mark - liq) < 2 * atr) out.push({ id: "liq_within_2atr", severity: "warning", title: "Liquidation within 2×ATR", detail: `Distance ${Math.abs(opts.mark - liq).toFixed(1)} vs ATR ${atr.toFixed(1)}.` });
  }

  if (plan.fundingCost > 0 && plan.riskAtStopUsd > 0 && plan.fundingCost > 0.1 * plan.riskAtStopUsd) {
    out.push({ id: "funding_drag", severity: "info", title: "Funding drag is material", detail: `Expected funding ${plan.fundingCost.toFixed(2)} USD over the horizon is >10% of risk.` });
  }
  for (const w of plan.warnings) out.push({ id: "plan_warning", severity: "info", title: "Sizing note", detail: w });

  const rank: Record<Severity, number> = { critical: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

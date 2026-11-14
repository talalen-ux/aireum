import { describe, expect, it } from "vitest";
import type { RiskBudget } from "./harvest";
import { applyResult, compareStrategies, exitForNetTarget, feedQuality, grossPnl, liquidationCheck, marginExhaustionPrice, netClosedPnl, netUnrealized, planHarvest, planMicro, remainingBudget, type Costs } from "./harvest";

const TAKER: Costs = { entryFee: 0.0006, exitFee: 0.0006, slippage: 0, fundingPerUnit: 0 };

describe("reference example (E=67,000, 0.06% taker each side)", () => {
  it("closing 1 BTC after a $100 move nets $19.54, not $100", () => {
    expect(grossPnl("long", 1, 67_000, 67_100)).toBe(100);
    expect(netClosedPnl("long", 1, 67_000, 67_100, TAKER)).toBeCloseTo(19.54, 2);
  });
  it("$100 net on 1 BTC needs ≈ $67,180.51", () => {
    // The skill reference prints 67,180.57, but its own formula (100 + 67000·1.0006)/0.9994 evaluates to 67,180.508.
    expect(exitForNetTarget("long", 1, 67_000, 100, TAKER)!).toBeCloseTo((100 + 67_000 * 1.0006) / 0.9994, 9);
    expect(exitForNetTarget("long", 1, 67_000, 100, TAKER)!).toBeCloseTo(67_180.51, 2);
  });
  it("$100 winner vs $250 loser needs a 71.43% win rate", () => {
    const m = planMicro({ dir: "long", entry: 67_000, stop: 66_000, netTargetUsd: 100, costs: TAKER, maxRiskUsd: 250 });
    expect(m.lossAtStop).toBeCloseTo(250, 6);
    expect(m.breakevenWinRate!).toBeCloseTo(250 / 350, 6);
  });
});

describe("minimum unit tests from the skill", () => {
  const costs: Costs = { entryFee: 0.0002, exitFee: 0.0006, slippage: 0.0001, fundingPerUnit: 3 };

  it("1. long and short net-target formulas invert the net-PnL equations", () => {
    for (const dir of ["long", "short"] as const) {
      for (const T of [25, 100, 750]) {
        const x = exitForNetTarget(dir, 0.37, 64_250, T, costs)!;
        expect(netClosedPnl(dir, 0.37, 64_250, x, costs)).toBeCloseTo(T, 6);
        expect(dir === "long" ? x > 64_250 : x < 64_250).toBe(true);
      }
    }
  });

  it("2. closing 25% reduces exposure by exactly 25%", () => {
    const p = planHarvest({ dir: "long", qty: 2, entry: 60_000, stop: 59_000, costs: TAKER, mode: "percent", steps: 1, stepValue: 25, stepDistance: 500 });
    expect(p.rows[0].qty).toBeCloseTo(0.5, 12);
    expect(p.rows[0].exposurePct).toBeCloseTo(0.75, 12);
  });

  it("3. partial profits never conceal a larger unrealized loss", () => {
    const p = planHarvest({ dir: "long", qty: 2, entry: 60_000, stop: 58_000, costs: TAKER, mode: "fixed_qty", steps: 1, stepValue: 0.5, stepDistance: 400 });
    const r = p.rows[0];
    expect(r.cumRealized).toBeGreaterThan(0);
    // remainder stopped: combined is negative and reported as such
    expect(r.combinedIfStopped).toBeLessThan(0);
    expect(r.combinedIfStopped).toBeCloseTo(r.cumRealized + netClosedPnl("long", 1.5, 60_000, 58_000, TAKER), 6);
    // combined at any mark = realized + net unrealized
    const mark = 59_000;
    expect(r.cumRealized + netUnrealized("long", r.remainingQty, 60_000, mark, TAKER)).toBeLessThan(0);
    expect(r.giveBackPrice!).toBeLessThan(60_400);
    expect(r.cumRealized + netUnrealized("long", r.remainingQty, 60_000, r.giveBackPrice!, TAKER)).toBeCloseTo(0, 4);
    expect(p.issues.some((i) => /do not cover the residual risk/.test(i.text))).toBe(true);
  });

  it("4. aggregate reduce-only quantities never exceed the remaining position", () => {
    const p = planHarvest({ dir: "short", qty: 1, entry: 60_000, stop: 61_000, costs: TAKER, mode: "fixed_qty", steps: 5, stepValue: 0.3, stepDistance: 300 });
    expect(p.issues.some((i) => i.level === "critical" && /exceed the open quantity/.test(i.text))).toBe(true);
    expect(p.rows.reduce((a, r) => a + r.qty, 0)).toBeLessThanOrEqual(1 + 1e-12); // simulation clamps
    expect(Math.min(...p.rows.map((r) => r.remainingQty))).toBeGreaterThanOrEqual(-1e-12);
  });

  it("5. a stop beyond liquidation is flagged unsafe", () => {
    const base = { venue: "binance", asset: "BTC" as const, dir: "long" as const, qty: 1, entry: 60_000, leverage: 50, mark: 60_000 };
    const bad = liquidationCheck({ ...base, stop: 58_000 });
    expect(bad.known).toBe(true);
    expect(bad.liqPrice!).toBeGreaterThan(58_000);
    expect(bad.stopBeyondLiq).toBe(true);
    expect(liquidationCheck({ ...base, stop: 59_700 }).stopBeyondLiq).toBe(false);
    const sh = liquidationCheck({ ...base, dir: "short", stop: 62_500 });
    expect(sh.stopBeyondLiq).toBe(true);
  });

  it("6. missing maintenance tiers suppress the precise liquidation price", () => {
    const r = liquidationCheck({ venue: "kucoin", asset: "BTC", dir: "long", qty: 1, entry: 60_000, leverage: 20, stop: 59_000, mark: 60_000 });
    expect(r.known).toBe(false);
    expect(r.liqPrice).toBeNull();
    expect(r.note).toMatch(/unknown/);
    // the exhaustion shortcut exists but is a different number and never reported as liquidation
    expect(r.exhaustion).toBe(marginExhaustionPrice("long", 60_000, 20));
  });

  it("7. cumulative realized losses reduce the budget across sessions and wins do not refill it", () => {
    let b: RiskBudget = { cumulativeLossLimitUsd: 1000, realizedLossesUsd: 0, otherOpenRiskUsd: 0 };
    b = applyResult(b, -300);
    b = JSON.parse(JSON.stringify(b)); // persisted and reloaded in a later session
    b = applyResult(b, +500);
    b = applyResult(b, -250);
    expect(remainingBudget(b).remaining).toBe(450);
    expect(remainingBudget({ ...b, otherOpenRiskUsd: 500 }).exhausted).toBe(true);
    expect(remainingBudget({ cumulativeLossLimitUsd: null, realizedLossesUsd: 0, otherOpenRiskUsd: 0 }).known).toBe(false);
  });

  it("8. stale feeds never produce a live signal", () => {
    expect(feedQuality("live", 200, 5).live).toBe(true);
    expect(feedQuality("live", 9000, 5).live).toBe(false);
    expect(feedQuality("live", null, 0).quality).toBe("unavailable");
    expect(feedQuality("simulation", 50, 7).live).toBe(false);
  });

  it("9. a $100 gross win is not labeled $100 net", () => {
    const m = planMicro({ dir: "short", entry: 67_000, stop: 67_500, netTargetUsd: 100, costs: TAKER, maxRiskUsd: 500, qty: 1 });
    expect(m.grossAtExit!).toBeGreaterThan(100);
    expect(m.costPerRoundTrip!).toBeCloseTo(m.grossAtExit! - 100, 9);
    expect(netClosedPnl("short", 1, 67_000, m.exit!, TAKER)).toBeCloseTo(100, 6);
  });

  it("10. comparison uses the same maximum dollar risk, not the same leverage", () => {
    const r = compareStrategies({
      dir: "long", entry: 60_000, stop: 59_400, costs: TAKER, riskUsd: 500, netTargetUsd: 100, maxTrades: 20, cooldownBars: 1,
      harvest: { mode: "percent", steps: 3, stepValue: 25, stepDistance: 300 }, volPerBar: 0.0015, driftPerBar: 0, bars: 240, paths: 400, seed: 1, stopGapBps: 0,
    });
    // both sized so that a stop costs exactly $500
    expect(-netClosedPnl("long", r.qtyA, 60_000, 59_400, TAKER)).toBeCloseTo(500, 6);
    expect(-netClosedPnl("long", r.qtyB, 60_000, 59_400, TAKER)).toBeCloseTo(500, 6);
    expect(r.a.worst).toBeGreaterThanOrEqual(-500 - 1e-6);
  });
});

describe("no edge in, no edge out", () => {
  const run = (drift: number) => compareStrategies({
    dir: "long", entry: 60_000, stop: 59_400, costs: TAKER, riskUsd: 500, netTargetUsd: 100, maxTrades: 30, cooldownBars: 1,
    harvest: { mode: "percent", steps: 3, stepValue: 25, stepDistance: 300 }, volPerBar: 0.0015, driftPerBar: drift, bars: 480, paths: 3000, seed: 42, stopGapBps: 0,
  });
  it("with zero drift, frequent $100 wins still give negative expectancy after costs", () => {
    const r = run(0);
    expect(r.bTradeWinRate!).toBeGreaterThan(0.6); // most trades win…
    expect(r.b.ev).toBeLessThan(0); // …and the strategy still loses
    expect(r.a.ev).toBeLessThan(0);
    expect(r.b.feesAvg).toBeGreaterThan(r.a.feesAvg); // more turnover, more fees
  });
  it("is deterministic for a given seed", () => {
    expect(run(0).b.ev).toBe(run(0).b.ev);
  });
});

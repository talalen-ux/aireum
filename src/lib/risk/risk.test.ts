import { describe, expect, it } from "vitest";
import { bankruptcyPrice, buildTiers, liquidationPrice, tierFor, TIER_TABLES } from "./exchanges";
import { planPosition, sizeFromRisk, type PlanInput } from "./position";
import { runChecks } from "./checks";
import { runMonteCarlo, type MCParams, type MCPosition } from "./montecarlo";
import { stress, summarize } from "./portfolio";

const flat = buildTiers([[1e12, 125, 0.004]]);

describe("tier tables", () => {
  it("derives continuous maintenance amounts", () => {
    const t = TIER_TABLES.binance.BTC;
    for (let i = 1; i < t.length; i++) {
      const b = t[i].floor;
      const mmPrev = b * t[i - 1].mmr - t[i - 1].cum;
      const mmNext = b * t[i].mmr - t[i].cum;
      expect(mmNext).toBeCloseTo(mmPrev, 6);
    }
    expect(t[1].cum).toBeCloseTo(50, 6); // 50,000 × (0.5% − 0.4%)
    expect(tierFor(t, 49_999).mmr).toBe(0.004);
    expect(tierFor(t, 50_000).mmr).toBe(0.005);
  });
});

describe("liquidation formulas", () => {
  it("Binance isolated long: hand-computed example", () => {
    // Q=1 BTC, E=10,000, margin 1,000 (10x), MMR 0.4%, cum 0
    // LP = (1000 + 0 − 10000) / (0.004 − 1) = 9036.1446
    const r = liquidationPrice({ venue: "binance", asset: "BTC", side: "long", contract: "linear", marginMode: "isolated", qty: 1, entry: 10_000, margin: 1_000, tiers: flat });
    expect(r.liqPrice).toBeCloseTo(9036.1446, 3);
    expect(r.bankruptcyPrice).toBeCloseTo(9000, 6);
    expect(r.trigger).toBe("mark");
  });
  it("Binance isolated short: hand-computed example", () => {
    // LP = (1000 + 10000) / (0.004 + 1) = 10956.17
    const r = liquidationPrice({ venue: "binance", asset: "BTC", side: "short", contract: "linear", marginMode: "isolated", qty: 1, entry: 10_000, margin: 1_000, tiers: flat });
    expect(r.liqPrice).toBeCloseTo(10956.1753, 3);
    expect(r.bankruptcyPrice).toBeCloseTo(11000, 6);
  });
  it("liquidation sits between entry and bankruptcy", () => {
    for (const venue of ["binance", "bybit", "okx"] as const) {
      const l = liquidationPrice({ venue, asset: "BTC", side: "long", contract: "linear", marginMode: "isolated", qty: 0.5, entry: 60_000, margin: 3_000 });
      expect(l.liqPrice!).toBeLessThan(60_000);
      expect(l.liqPrice!).toBeGreaterThan(l.bankruptcyPrice!);
      const s = liquidationPrice({ venue, asset: "BTC", side: "short", contract: "linear", marginMode: "isolated", qty: 0.5, entry: 60_000, margin: 3_000 });
      expect(s.liqPrice!).toBeGreaterThan(60_000);
      expect(s.liqPrice!).toBeLessThan(s.bankruptcyPrice!);
    }
  });
  it("Bybit isolated long matches E − (IM − MM)/Q", () => {
    const r = liquidationPrice({ venue: "bybit", asset: "BTC", side: "long", contract: "linear", marginMode: "isolated", qty: 1, entry: 50_000, margin: 5_000, closeFeeRate: 0, tiers: buildTiers([[1e12, 100, 0.005]]) });
    // MM = 250 → LP = 50000 − 4750 = 45250
    expect(r.liqPrice).toBeCloseTo(45_250, 6);
  });
  it("inverse long/short bracket entry and bankruptcy", () => {
    const tiers = buildTiers([[1e12, 125, 0.004]]);
    // N = $10,000, E = 10,000, margin 0.1 BTC (10x)
    const l = liquidationPrice({ venue: "binance", asset: "BTC", side: "long", contract: "inverse", marginMode: "isolated", qty: 1, entry: 10_000, margin: 0.1, tiers });
    // P = 10000·1.004 / (0.1 + 1) = 9127.27
    expect(l.liqPrice).toBeCloseTo(9127.2727, 3);
    expect(l.bankruptcyPrice).toBeCloseTo(10000 / 1.1, 3);
    const s = liquidationPrice({ venue: "binance", asset: "BTC", side: "short", contract: "inverse", marginMode: "isolated", qty: 1, entry: 10_000, margin: 0.1, tiers });
    // P = 10000·0.996 / (1 − 0.1) = 11066.67
    expect(s.liqPrice).toBeCloseTo(11066.6667, 3);
    expect(bankruptcyPrice({ side: "short", contract: "inverse", qty: 1, entry: 10_000, margin: 0.1 })).toBeCloseTo(10000 / 0.9, 3);
  });
  it("fully collateralized 1x inverse short cannot be liquidated", () => {
    const s = liquidationPrice({ venue: "binance", asset: "BTC", side: "short", contract: "inverse", marginMode: "isolated", qty: 1, entry: 10_000, margin: 1.0, tiers: flat });
    expect(s.liqPrice).toBeNull();
  });
});

const base: PlanInput = {
  asset: "BTC", side: "long", venue: "binance", contract: "linear", marginMode: "isolated", leverage: 10, maxRiskUsd: 1_000,
  entries: [{ price: 60_000, weight: 1, filled: true }], stops: [{ price: 58_000, weight: 1, reduceOnly: true }], targets: [{ price: 64_000, weight: 1, reduceOnly: true }],
  makerFee: 0, takerFee: 0, entryIsMaker: true, fundingRate: 0, fundingIntervalHours: 8, horizonHours: 24, stopSlippageBps: 0,
};

describe("sizing & position", () => {
  it("qty = risk / per-unit risk with zero costs", () => {
    const p = planPosition(base);
    expect(p.qty).toBeCloseTo(0.5, 9);
    expect(p.notional).toBeCloseTo(30_000, 6);
    expect(p.initialMargin).toBeCloseTo(3_000, 6);
    expect(p.riskAtStopUsd).toBeCloseTo(1_000, 6);
    expect(p.deltaPer100).toBeCloseTo(50, 9);
    expect(p.targetLegs[0].rMultiple).toBeCloseTo(2, 6);
  });
  it("costs reduce size so total loss still equals the risk budget", () => {
    const p = planPosition({ ...base, takerFee: 0.0005, makerFee: 0.0002, stopSlippageBps: 5, fundingRate: 0.0001 });
    expect(p.qty).toBeLessThan(0.5);
    expect(p.riskAtStopUsd).toBeCloseTo(1_000, 4);
  });
  it("sizeFromRisk rejects stops on wrong side", () => {
    expect(sizeFromRisk({ side: "short", avgEntry: 100, avgStop: 90, maxRiskUsd: 10, entryFeeRate: 0, exitFeeRate: 0, slippageBps: 0, fundingRate: 0, fundingIntervalHours: 8, horizonHours: 8 }).qty).toBe(0);
  });
  it("staggered entries average correctly and slippage fn is honored", () => {
    const p = planPosition({ ...base, entries: [{ price: 60_000, weight: 1, filled: true }, { price: 59_000, weight: 1 }], slippage: () => 10 });
    expect(p.avgEntry).toBeCloseTo(59_500, 6);
    expect(p.stopSlippageUsd).toBeGreaterThan(0);
    expect(p.liqFilledOnly).not.toBeNull();
  });
  it("added margin moves liquidation away", () => {
    const p = planPosition(base);
    expect(p.liqShiftPer1000Usd!).toBeLessThan(0);
  });
});

describe("checks", () => {
  it("flags stop beyond liquidation at high leverage", () => {
    const input = { ...base, leverage: 50 };
    const p = planPosition(input);
    expect(p.liq.liqPrice!).toBeGreaterThan(58_000);
    const c = runChecks(input, p);
    expect(c.some((x) => x.id === "stop_beyond_liq" && x.severity === "critical")).toBe(true);
  });
  it("flags uncovered quantity, target overflow, non reduce-only, tier leverage", () => {
    const input: PlanInput = { ...base, leverage: 125, maxRiskUsd: 100_000, stops: [{ price: 59_900, weight: 0.5, reduceOnly: false }], targets: [{ price: 61_000, weight: 0.8 }, { price: 62_000, weight: 0.5 }] };
    const p = planPosition(input);
    const ids = runChecks(input, p).map((x) => x.id);
    expect(ids).toContain("uncovered_qty");
    expect(ids).toContain("targets_exceed");
    expect(ids).toContain("stop_not_reduce_only");
    expect(ids).toContain("leverage_tier");
  });
  it("flags pending entries that push liquidation beyond the stop", () => {
    // cross margin with a fixed wallet: extra fills add exposure without adding collateral
    const input: PlanInput = { ...base, marginMode: "cross", walletBalance: 3_000, leverage: 20, entries: [{ price: 60_000, weight: 1, filled: true }, { price: 58_200, weight: 3 }], stops: [{ price: 57_000, weight: 1 }], qtyOverride: 2 };
    const p = planPosition(input);
    const c = runChecks(input, p);
    expect(c.find((x) => x.id === "pending_pushes_liq")).toBeTruthy();
  });
  it("no stop is critical", () => {
    const input = { ...base, stops: [] };
    expect(runChecks(input, planPosition(input))[0].id).toBe("no_stop");
  });
});

const mcPos = (liq: number | null, over: Partial<MCPosition> = {}): MCPosition => ({
  side: "long", qty: 1, entry: 60_000, start: 60_000, liq, margin: 600, stops: [], targets: [{ price: 66_000, fraction: 1 }],
  takerFee: 0, makerFee: 0, entryFeeRate: 0, fundingRate: 0, fundingIntervalHours: 8, ...over,
});
const mcP = (over: Partial<MCParams> = {}): MCParams => ({ seed: 42, paths: 2_000, horizonHours: 24, stepsPerHour: 12, annualVol: 0.6, model: "gbm", stopFailProb: 0, stopSlippageBps: 0, ...over });

describe("monte carlo", () => {
  it("is deterministic for a seed", () => {
    const a = runMonteCarlo(mcPos(55_000), mcP({ model: "jump" }));
    const b = runMonteCarlo(mcPos(55_000), mcP({ model: "jump" }));
    expect(a.expectedPnl).toBe(b.expectedPnl);
    expect(a.pLiquidation).toBe(b.pLiquidation);
    expect(a.provenance).toBe("modeled");
  });
  it("zero vol never liquidates", () => {
    const r = runMonteCarlo(mcPos(59_000), mcP({ annualVol: 0 }));
    expect(r.pLiquidation).toBe(0);
    expect(r.expectedPnl).toBeCloseTo(0, 6);
  });
  it("100x leverage liquidates far more often than 5x", () => {
    const hi = runMonteCarlo(mcPos(59_640), mcP());
    const lo = runMonteCarlo(mcPos(48_240), mcP());
    expect(hi.pLiquidation).toBeGreaterThan(0.5);
    expect(lo.pLiquidation).toBeLessThan(0.01);
    expect(hi.pLiqBeforeRebound).toBeGreaterThan(0);
  });
  it("a stop above liquidation converts liquidations into stops", () => {
    const r = runMonteCarlo(mcPos(57_000, { stops: [{ price: 58_500, fraction: 1 }] }), mcP());
    expect(r.pLiquidation).toBe(0);
    expect(r.pStop).toBeGreaterThan(0);
  });
  it("bootstrap and student-t run", () => {
    expect(runMonteCarlo(mcPos(55_000), mcP({ model: "bootstrap", returns: [0.001, -0.001, 0.002, -0.0025] })).paths).toBe(2000);
    expect(runMonteCarlo(mcPos(55_000), mcP({ model: "student_t", tDof: 4 })).pnlQuantiles.p05).toBeLessThan(0);
  });
});

describe("portfolio", () => {
  const positions = [
    { id: "btcL", asset: "BTC" as const, side: "long" as const, qty: 1, entry: 60_000, liq: 54_000, margin: 6_000 },
    { id: "ethS", asset: "ETH" as const, side: "short" as const, qty: 10, entry: 3_000, liq: 3_270, margin: 3_000 },
  ];
  const ctx = { prices: { BTC: 60_000, ETH: 3_000 }, ethBeta: 1.2 };
  it("summarizes delta and liquidation order", () => {
    const s = summarize(positions, ctx);
    expect(s.netDeltaUsd).toBeCloseTo(30_000, 6);
    expect(s.btcBetaDeltaUsd).toBeCloseTo(60_000 - 36_000, 6);
    expect(s.deltaPer100Btc).toBeCloseTo(40, 6);
    expect(s.liquidationOrder[0].id).toBe("ethS"); // +9% ETH = +7.5% BTC < −10%
  });
  it("stresses with liquidations", () => {
    const rows = stress(positions, ctx, [-0.12, 0.1]);
    expect(rows[0].liquidated).toEqual(["btcL"]);
    expect(rows[1].liquidated).toEqual(["ethS"]);
  });
});

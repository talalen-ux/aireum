import { describe, expect, it } from "vitest";
import { analyzeCard, FIVE_CARDS, maxQuantityForRisk, noEdgeExpectancy, noEdgeSurvival, requiredQuantity, survivalMatrix } from "./conviction";

const card = (a: string) => analyzeCard(FIVE_CARDS.find((c) => c.asset === a)!);
const NO = { entryFee: 0, exitFee: 0, slippage: 0, fundingPerUnit: 0 };
const FEES = { entryFee: 0.0005, exitFee: 0.0005, slippage: 0.0002, fundingPerUnit: 0 };

describe("forensic card report reproduces the reference reconstruction", () => {
  it("BTC: ~107.6145 BTC, ~$6.68M notional, ~$334k margin", () => {
    const f = card("BTCUSDT");
    expect(f.move).toBeCloseTo(3852.3, 6);
    expect(f.quantity!).toBeCloseTo(107.61, 2); // reference prints 107.6145; exact is 107.6133
    expect(f.notional! / 1e6).toBeCloseTo(6.68, 2);
    expect(f.nominalMargin! / 1e3).toBeCloseTo(334, 0);
    expect(f.possiblyOpen).toBe(true); // "Fair Price"
    expect(f.roiConsistent).toBe(true); // 6.21% × 20 = 124.2% vs printed 123.16%
  });
  it("ZEC, XRP, NVDA sizes", () => {
    expect(card("ZECUSDT").quantity!).toBeCloseTo(2388.43, 1);
    expect(card("ZECUSDT").possiblyOpen).toBe(false); // "Avg Close Price"
    expect(card("XRPUSDT").quantity! / 1e6).toBeCloseTo(5.32, 2);
    expect(card("NVDAUSDT").quantity!).toBeCloseTo(12957.8, 0);
    expect(card("NVDAUSDT").nominalMargin! / 1e3).toBeCloseTo(237, 0);
    expect(card("NVDAUSDT").roiConsistent).toBeNull(); // ROI not shown → cannot reconcile
  });
  it("ETH: no entry/exit → size only from PNL ÷ ROI, flagged as weaker", () => {
    const f = card("ETHUSDT");
    expect(f.basis).toBe("roi_only");
    expect(f.quantity).toBeNull();
    expect(f.nominalMargin! / 1e3).toBeCloseTo(295.4, 1);
    expect(f.notional! / 1e6).toBeCloseTo(5.91, 2);
    expect(f.missing).toContain("entry price");
  });
  it("never reports a liquidation price for a card", () => {
    for (const c of FIVE_CARDS) {
      const f = analyzeCard(c);
      expect(f.missing).toContain("actual liquidation price");
      expect(Object.keys(f)).not.toContain("liqPrice");
    }
  });
});

describe("profit target engine", () => {
  it("net target is met exactly after costs, and needs more size than the cost-free case", () => {
    const free = requiredQuantity("long", 100_000, 5, 100_000, NO)!;
    expect(free.qty).toBeCloseTo(20, 9); // $100k / $5k per BTC
    const paid = requiredQuantity("long", 100_000, 5, 100_000, FEES)!;
    expect(paid.qty).toBeGreaterThan(free.qty);
    expect(paid.grossNeeded - paid.costs).toBeCloseTo(100_000, 6);
    expect(requiredQuantity("short", 100_000, 0.05, 100_000, FEES)).toBeNull(); // costs exceed the move
  });
  it("leverage does not change the size or notional a target needs — only the margin", () => {
    const { rows } = survivalMatrix({ dir: "short", asset: "BTC", venue: "binance", entry: 100_000, movePct: 5, target: 100_000, leverages: [5, 20, 50], costs: NO, capitalUsd: null, remainingBudgetUsd: null, depthUsd: null });
    expect(new Set(rows.map((r) => r.notional.toFixed(2))).size).toBe(1);
    expect(rows[0].nominalMargin).toBeCloseTo(rows[1].nominalMargin * 4, 6);
  });
  it("risk-based size cap: stop loss on that size equals the planned risk", () => {
    const q = maxQuantityForRisk("long", 100_000, 98_000, 10_000, NO);
    expect(q).toBeCloseTo(5, 9);
    expect(maxQuantityForRisk("long", 100_000, 98_000, 10_000, FEES)).toBeLessThan(q);
  });
});

describe("survival", () => {
  it("no-edge chance of target before knock-out is a/(a+b) and falls as leverage rises", () => {
    expect(noEdgeSurvival(100, 115, 95)!).toBeCloseTo(5 / 20, 12);
    const { rows } = survivalMatrix({ dir: "long", asset: "BTC", venue: "binance", entry: 100_000, movePct: 5, target: 100_000, leverages: [5, 10, 20, 50], costs: FEES, capitalUsd: 50_000, remainingBudgetUsd: 20_000, depthUsd: 50e6 });
    const p = rows.map((r) => r.pTargetBeforeKnockout!);
    expect(p[0]).toBeGreaterThan(p[1]);
    expect(p[2]).toBeGreaterThan(p[3]);
    expect(rows[3].flags.join(" ")).toMatch(/Extreme leverage/);
    expect(rows[3].flags.join(" ")).toMatch(/closer than the target/);
    expect(rows[0].fundable).toBe(false); // ~$2M notional / 5 = ~$400k margin > $50k
    expect(rows[0].liqKnown).toBe(true);
  });
  it("with no edge, expected value is about zero before costs at any leverage, and negative after", () => {
    for (const costs of [NO, FEES]) {
      const { rows } = survivalMatrix({ dir: "long", asset: "ZEC", venue: "mexc", entry: 500, movePct: 8, target: 100_000, leverages: [5, 20], costs, capitalUsd: null, remainingBudgetUsd: null, depthUsd: null });
      for (const r of rows) {
        expect(r.liqKnown).toBe(false); // MEXC tiers unknown → exhaustion boundary only
        expect(r.liqPrice).toBeNull();
        const ev = noEdgeExpectancy(r, 100_000)!;
        if (costs === NO) expect(Math.abs(ev)).toBeLessThan(1e-6);
        else expect(ev).toBeLessThan(0);
      }
    }
  });
});

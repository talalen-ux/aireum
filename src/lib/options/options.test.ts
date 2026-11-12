import { describe, expect, it } from "vitest";
import { bsGreeks, bsPrice, fromInversePremium, impliedVol, toInversePremium } from "./blackscholes";
import { parseBookSummary, parseInstrument } from "./deribit";
import { DEALER_ASSUMPTIONS, analyzeChain, classifyExpiry, gexByStrike, gexProfile, interp, maxPain, prepareRows, putCallRatios, totalGexAt, volSurface } from "./analytics";
import { syntheticChain } from "./synthetic";
import type { OptionChain, OptionRow } from "./types";

const base = { S: 60000, K: 65000, T: 0.25, sigma: 0.55, r: 0.03 };

describe("Black-Scholes", () => {
  it("satisfies put-call parity", () => {
    const c = bsPrice({ ...base, type: "C" });
    const p = bsPrice({ ...base, type: "P" });
    expect(c - p).toBeCloseTo(base.S - base.K * Math.exp(-base.r * base.T), 6);
  });

  it("greeks match finite differences", () => {
    for (const type of ["C", "P"] as const) {
      const g = bsGreeks({ ...base, type });
      const h = base.S * 1e-4;
      const up = bsGreeks({ ...base, S: base.S + h, type });
      const dn = bsGreeks({ ...base, S: base.S - h, type });
      expect(g.delta).toBeCloseTo((up.price - dn.price) / (2 * h), 4);
      expect(g.gamma / ((up.delta - dn.delta) / (2 * h))).toBeCloseTo(1, 3);
      const hv = 1e-4;
      const vu = bsGreeks({ ...base, sigma: base.sigma + hv, type });
      const vd = bsGreeks({ ...base, sigma: base.sigma - hv, type });
      expect(g.vega / ((vu.price - vd.price) / (2 * hv))).toBeCloseTo(1, 3);
      expect(g.vanna / ((vu.delta - vd.delta) / (2 * hv))).toBeCloseTo(1, 3);
      const ht = 1e-4;
      const tu = bsGreeks({ ...base, T: base.T + ht, type });
      const td = bsGreeks({ ...base, T: base.T - ht, type });
      // theta / charm are per unit of calendar time PASSING => -d/dT
      expect(g.theta / (-(tu.price - td.price) / (2 * ht))).toBeCloseTo(1, 3);
      expect(g.charm / (-(tu.delta - td.delta) / (2 * ht))).toBeCloseTo(1, 2);
    }
  });

  it("implied vol round-trips across strikes and types", () => {
    for (const K of [40000, 55000, 60000, 70000, 90000]) {
      for (const type of ["C", "P"] as const) {
        const sigma = 0.62;
        const px = bsPrice({ S: 60000, K, T: 0.1, sigma, type });
        if (px < 1e-6) continue;
        expect(impliedVol(px, 60000, K, 0.1, type)).toBeCloseTo(sigma, 5);
      }
    }
  });

  it("rejects prices outside no-arbitrage bounds", () => {
    expect(impliedVol(70000, 60000, 60000, 0.1, "C")).toBeNull();
    expect(impliedVol(1, 60000, 40000, 0.1, "C")).toBeNull(); // below intrinsic
  });

  it("converts inverse premiums", () => {
    expect(fromInversePremium(toInversePremium(1234, 61000), 61000)).toBeCloseTo(1234, 9);
  });
});

describe("Deribit parsing", () => {
  it("parses instrument names", () => {
    expect(parseInstrument("BTC-27DEC24-100000-C")).toEqual({ asset: "BTC", expiry: Date.UTC(2024, 11, 27, 8), strike: 100000, type: "C" });
    expect(parseInstrument("ETH-3JAN25-3500-P")).toEqual({ asset: "ETH", expiry: Date.UTC(2025, 0, 3, 8), strike: 3500, type: "P" });
    expect(parseInstrument("XRP_USDC-30JUN25-2d5-C")?.strike).toBe(2.5);
    expect(parseInstrument("BTC-PERPETUAL")).toBeNull();
    expect(parseInstrument("BTC-27XYZ24-100000-C")).toBeNull();
  });

  it("normalizes a book summary fixture", () => {
    const now = Date.UTC(2026, 10, 1);
    const rows = parseBookSummary(
      [
        { instrument_name: "BTC-27NOV26-100000-C", open_interest: 120.5, volume: 10, mark_iv: 52.3, underlying_price: 98500, mark_price: 0.031 },
        { instrument_name: "BTC-27NOV26-90000-P", open_interest: 80, volume: 4, mark_iv: 55.1, underlying_price: 98500 },
        { instrument_name: "BTC-1JAN20-90000-P", open_interest: 80, volume: 4, mark_iv: 55.1 }, // expired
        { instrument_name: "garbage", open_interest: 1 },
      ],
      now,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ strike: 90000, type: "P", oi: 80, markIv: 0.551, underlyingPrice: 98500 });
    expect(rows[1].markIv).toBeCloseTo(0.523, 9);
  });
});

const NOW = Date.UTC(2026, 10, 12, 0);
const EXP = Date.UTC(2026, 10, 27, 8);
function row(strike: number, type: "C" | "P", oi: number, iv = 0.5): OptionRow {
  return { instrument: `T-${strike}-${type}`, expiry: EXP, strike, type, oi, volume: oi / 10, markIv: iv, underlyingPrice: 100 };
}
function chain(rows: OptionRow[], underlying = 100): OptionChain {
  return { status: "ok", asset: "BTC", asOf: NOW, underlying, rows, source: "test", provenance: "simulated", mode: "simulation", licensing: "" };
}

describe("analytics", () => {
  it("computes max pain on a toy chain", () => {
    // Calls stacked at 110, puts at 90 -> pain minimized between them (at 100).
    const rows = [row(90, "P", 100), row(100, "C", 10), row(100, "P", 10), row(110, "C", 100)];
    const mp = maxPain(rows, EXP);
    expect(mp.strike).toBe(100);
    const at90 = mp.curve.find((c) => c.strike === 90)!.payoutUsd;
    expect(at90).toBe(10 * 10); // only 100-put pays 10 each
  });

  it("put/call ratios", () => {
    const pcr = putCallRatios([row(90, "P", 30), row(110, "C", 60)]);
    expect(pcr.oiRatio).toBeCloseTo(0.5);
  });

  it("GEX sign conventions follow the dealer assumption", () => {
    const prepared = prepareRows(chain([row(100, "C", 100), row(100, "P", 100)]), NOW);
    const shortCalls = gexByStrike(prepared, 100, "short_calls_long_puts");
    expect(shortCalls.rows[0].callGex).toBeLessThan(0);
    expect(shortCalls.rows[0].putGex).toBeGreaterThan(0);
    expect(shortCalls.totalGex).toBeCloseTo(0, 6); // equal gamma, opposite signs
    const longCalls = gexByStrike(prepared, 100, "long_calls_short_puts");
    expect(longCalls.rows[0].callGex).toBeGreaterThan(0);
    expect(gexByStrike(prepared, 100, "short_all").totalGex).toBeLessThan(0);
    const gross = gexByStrike(prepared, 100, "gross_unsigned");
    expect(gross.totalGex).toBeGreaterThan(0);
    // magnitude: gamma × OI × S² × 1%
    const T = (EXP - NOW) / (365 * 86_400_000);
    const gamma = Math.exp(-0.5 * (0.5 * 0.5 * Math.sqrt(T)) ** 2) / Math.sqrt(2 * Math.PI) / (100 * 0.5 * Math.sqrt(T));
    expect(gross.rows[0].callGex).toBeCloseTo(gamma * 100 * 100 * 100 * 0.01, 3);
    expect(gross.assumptions.length).toBeGreaterThan(0);
    expect(gross.provenance).toBe("modeled");
  });

  it("finds the zero-gamma flip on a toy chain", () => {
    // Dealers long calls at 110 (positive gamma above), short puts at 90 (negative below):
    // with equal OI the flip sits midway (~100, slightly below due to S² weighting).
    const prepared = prepareRows(chain([row(90, "P", 100), row(110, "C", 100)]), NOW);
    const prof = gexProfile(prepared, 100, "long_calls_short_puts", 0.15, 61);
    expect(prof.zeroGamma).not.toBeNull();
    const z = prof.zeroGamma as number;
    expect(z).toBeGreaterThan(95);
    expect(z).toBeLessThan(105);
    expect(Math.abs(totalGexAt(prepared, z, 100, DEALER_ASSUMPTIONS.long_calls_short_puts))).toBeLessThan(1e-3);
    expect(gexProfile(prepared, 100, "gross_unsigned").zeroGamma).toBeNull();
  });

  it("vol surface: ATM interpolation and skew sign", () => {
    const rows: OptionRow[] = [];
    for (const K of [70, 80, 90, 100, 110, 120, 130]) {
      const iv = 0.5 - 0.004 * (K - 100); // downside skew: puts richer
      rows.push(row(K, "C", 10, iv), row(K, "P", 10, iv));
    }
    const s = volSurface(prepareRows(chain(rows), NOW));
    expect(s.term).toHaveLength(1);
    expect(s.term[0].atmIv).toBeCloseTo(0.5, 6);
    expect(s.term[0].rr25).toBeLessThan(0);
  });

  it("interp returns null outside range", () => {
    expect(interp([[0, 0], [1, 1]], 0.5)).toBe(0.5);
    expect(interp([[0, 0], [1, 1]], 2)).toBeNull();
  });

  it("classifies expiries", () => {
    expect(classifyExpiry(Date.UTC(2026, 11, 25, 8))).toBe("quarterly"); // last Fri Dec 2026
    expect(classifyExpiry(Date.UTC(2026, 10, 27, 8))).toBe("monthly");
    expect(classifyExpiry(Date.UTC(2026, 10, 20, 8))).toBe("weekly");
    expect(classifyExpiry(Date.UTC(2026, 10, 18, 8))).toBe("daily");
  });

  it("analyzes a synthetic chain end to end deterministically", () => {
    const c1 = syntheticChain("BTC", 97000, NOW);
    const c2 = syntheticChain("BTC", 97000, NOW);
    expect(c1.rows).toEqual(c2.rows);
    expect(c1.mode).toBe("simulation");
    const a = analyzeChain(c1, 97000, "short_calls_long_puts", NOW);
    expect(a.surface.term.length).toBeGreaterThan(3);
    expect(a.pcr.oiRatio).not.toBeNull();
    expect(a.expiries.events.length).toBeGreaterThan(0);
    expect(a.maxPain?.strike).toBeGreaterThan(0);
    expect(a.walls.callWalls.length).toBe(3);
    expect(Number.isFinite(a.greeks.dealerVannaUsdPerVolPt)).toBe(true);
  });
});

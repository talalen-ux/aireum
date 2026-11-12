import { afterEach, describe, expect, it, vi } from "vitest";
import { Engine } from "./engine";
import { Simulator } from "../sim/simulator";
import { L2Book } from "../core/orderbook";
import { evaluateExhaustion } from "./exhaustion";
import { buildLiqMap } from "./liqmodel";
import { computeFeatures } from "./features";
import { emptyBar, type Bar } from "./bars";

afterEach(() => vi.useRealTimers());

function runSim(minutes: number) {
  vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "clearInterval", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-01-05T00:00:00Z"));
  const e = new Engine("BTC", "simulation");
  const sim = new Simulator("BTC");
  e.loadHistory(sim.history(), { source: "sim", flowAvailable: true, errors: [] });
  sim.start((x) => e.ingest(x));
  for (let s = 0; s < minutes * 60 * 4; s++) {
    vi.advanceTimersByTime(250);
    e.tick();
  }
  sim.stop();
  return e;
}

describe("engine end-to-end on simulator", () => {
  it("produces a coherent snapshot with no NaNs in headline metrics", () => {
    const e = runSim(7);
    const s = e.snapshot({ includeChart: true });
    expect(s.price).toBeGreaterThan(50_000);
    expect(s.liveVenues).toBeGreaterThanOrEqual(5);
    for (const tf of ["5m", "15m", "1h", "4h", "1d"] as const) {
      const a = s.assessments[tf]!;
      expect(a).toBeTruthy();
      expect(a.directionalPressure === null || Number.isFinite(a.directionalPressure)).toBe(true);
      expect(a.dataConfidence).toBeGreaterThan(0);
    }
    expect(s.liqMap).not.toBeNull();
    expect(s.heat.cols.length).toBeGreaterThan(100);
    expect(s.flow.length).toBeGreaterThan(100);
    expect(s.leadLag?.scores.length).toBeGreaterThan(2);
    // injected gaps must be detected and recovered (fail visibly, then resync)
    const gaps = s.venues.reduce((a, v) => a + v.gaps, 0);
    expect(gaps).toBeGreaterThanOrEqual(1);
    expect(s.venues.filter((v) => v.state === "live").length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(s)).not.toContain("NaN");
  }, 60_000);

  it("lead-lag identifies the simulated leading venue", () => {
    const e = runSim(5);
    const s = e.snapshot({ includeChart: false });
    // binance perp has zero lag in the simulator
    expect(s.leadLag?.scores[0].key).toBe("binance:perp");
  }, 60_000);
});

describe("order book gap recovery", () => {
  const meta = { inst: { venue: "binance" as const, symbol: "X", asset: "BTC" as const, market: "perp" as const, contract: "linear" as const, quote: "USDT", multiplier: 1 }, exchTs: 1, recvTs: 1, source: "t", quality: ["ok" as const] };
  it("detects a broken prevSeq chain, refuses analytics, and recovers on snapshot", () => {
    const b = new L2Book();
    b.applySnapshot({ ...meta, kind: "book_snapshot", bids: [[100, 1]], asks: [[101, 1]], seq: 10 });
    expect(b.applyDelta({ ...meta, kind: "book_delta", bids: [[100, 2]], asks: [], seqFirst: 11, seqLast: 11, prevSeq: 10 })).toBe("applied");
    expect(b.applyDelta({ ...meta, kind: "book_delta", bids: [[99, 2]], asks: [], seqFirst: 14, seqLast: 14, prevSeq: 13 })).toBe("gap");
    expect(b.valid).toBe(false);
    expect(b.applyDelta({ ...meta, kind: "book_delta", bids: [[98, 2]], asks: [], seqFirst: 15, seqLast: 15, prevSeq: 14 })).toBe("not_ready");
    b.applySnapshot({ ...meta, kind: "book_snapshot", bids: [[100, 3]], asks: [[101, 1]], seq: 20 });
    expect(b.valid).toBe(true);
    expect(b.applyDelta({ ...meta, kind: "book_delta", bids: [], asks: [[101, 0.5]], seqFirst: 19, seqLast: 19, prevSeq: 18 })).toBe("ignored_stale");
    expect(b.bestBid()).toEqual([100, 3]);
  });
});

function synthetic(n: number, f: (i: number, b: Bar) => void): Bar[] {
  const out: Bar[] = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const b = emptyBar(i * 60_000, px);
    f(i, b);
    px = b.c;
    out.push(b);
  }
  return out;
}

describe("exhaustion engine", () => {
  // 120 calm bars, 30 heavy-selling bars with high impact, then 15 bars where selling persists but impact collapses & OI falls
  const bars = synthetic(170, (i, b) => {
    const o = b.o;
    let flow = 0, impact = 0, oiStep = 0;
    if (i < 120) { flow = Math.sin(i) * 0.05; impact = 0.002; }
    else if (i < 152) { flow = -0.35; impact = 0.004; oiStep = 0.001; }
    else { flow = -0.3; impact = 0.0006; oiStep = -0.004; }
    const r = flow * impact * 10 + Math.cos(i * 1.7) * 0.0003;
    b.c = o * (1 + r);
    b.h = Math.max(o, b.c) * 1.0005;
    b.l = Math.min(o, b.c) * 0.9995;
    const v = 100;
    b.spotBuy = v * 0.35 * (0.5 + (i >= 152 ? -0.05 : flow) / 2);
    b.spotSell = v * 0.35 - b.spotBuy;
    b.perpBuy = v * 0.65 * (0.5 + flow / 2);
    b.perpSell = v * 0.65 - b.perpBuy;
    b.oi = 1000 * Math.exp((i > 120 ? (Math.min(i, 152) - 120) * 0.001 : 0) + (i > 152 ? (i - 152) * -0.004 : 0) + oiStep * 0);
    if (i >= 140 && i <= 156) b.liqLong = i === 150 ? 10 : 3;
  });

  it("flags downside exhaustion with C1, C2, C3 met and lists the missing book input", () => {
    const s = evaluateExhaustion(bars, "long", null)!;
    expect(s).toBeTruthy();
    const c = Object.fromEntries(s.conditions.map((x) => [x.id, x.met]));
    expect(c.C1!).toBeGreaterThan(0.5);
    expect(c.C2!).toBeGreaterThan(0.5);
    expect(c.C3!).toBeGreaterThan(0.5);
    expect(c.C4).toBeNull(); // no live book → unavailable, not invented
    expect(s.completeness).toBeLessThan(1);
    expect(s.strength).toBeGreaterThan(0.4);
    expect(s.invalidation).toBeLessThan(s.extreme);
  });

  it("does not flag upside exhaustion in the same tape", () => {
    const s = evaluateExhaustion(bars, "short", null)!;
    expect(s.strength).toBeLessThan(0.4);
  });

  it("features are point-in-time: changing future bars does not alter past features", () => {
    const a = computeFeatures(bars, 140);
    const mutated = bars.map((b, i) => (i > 140 ? { ...b, c: b.c * 2, spotBuy: 0 } : b));
    expect(computeFeatures(mutated, 140)).toEqual(a);
  });
});

describe("modeled liquidation map", () => {
  it("places long clusters below and short clusters above price, with uncertainty bands", () => {
    const bars = synthetic(300, (i, b) => { b.c = b.o * (1 + Math.sin(i / 9) * 0.001); b.h = b.c * 1.001; b.l = b.c * 0.999; b.oi = 1000 + i * 2; b.perpBuy = 60; b.perpSell = 40; });
    const m = buildLiqMap(bars, bars[bars.length - 1].c)!;
    expect(m.totalLongUsd).toBeGreaterThan(0);
    expect(m.totalShortUsd).toBeGreaterThan(0);
    for (const b of m.buckets) {
      if (b.longUsd > 0) expect(b.price).toBeLessThan(m.price);
      if (b.shortUsd > 0) expect(b.price).toBeGreaterThan(m.price);
      expect(b.longLow).toBeLessThanOrEqual(b.longHigh);
    }
    expect(m.assumptions.length).toBeGreaterThan(3);
  });
});

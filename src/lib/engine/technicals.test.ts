import { describe, expect, it } from "vitest";
import { emptyBar, type Bar } from "./bars";
import { detect2B, gannFans, gannLevel, swings, williamsVixFix, wvfState } from "./technicals";
import { aggregateVol, parseDvol } from "./dvol";

function series(closes: number[], wick = 0.2): Bar[] {
  return closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    const b = emptyBar(i * 3_600_000, o);
    b.o = o; b.c = c; b.h = Math.max(o, c) + wick; b.l = Math.min(o, c) - wick;
    return b;
  });
}

describe("Williams VIX Fix", () => {
  it("is 0 at new highs and rises on a drop from the 22-bar closing high", () => {
    const b = series([...Array(30)].map((_, i) => 100 + i));
    const w = williamsVixFix(b);
    expect(w.at(-1)!.c).toBe(0);
    const crash = series([...Array(60)].map((_, i) => 100 + i).concat([140, 125]));
    const w2 = williamsVixFix(crash);
    // max close in window = 129, low of last bar = 99.8
    expect(w2.at(-1)!.h).toBeCloseTo(((159 - 124.8) / 159) * 100, 6);
    expect(wvfState(w2)?.spike).toBe(true);
  });
});

describe("swing pivots", () => {
  it("are only confirmed k bars later (no look-ahead)", () => {
    const c = [1, 2, 3, 4, 5, 4, 3, 2, 1, 2, 3];
    const H = c, L = c, T = c.map((_, i) => i);
    expect(swings(H, L, T, 3, 6).some((p) => p.i === 4)).toBe(false);
    expect(swings(H, L, T, 3, 7).find((p) => p.i === 4)?.kind).toBe("high");
  });
});

describe("2B reversal", () => {
  // range 100–110, swing high at 110, then a poke to 112 that closes back at 108
  const closes = [...Array(40)].map((_, i) => 105 + 5 * Math.sin(i / 3));
  const bars = series(closes);
  const hi = Math.max(...bars.slice(0, 40).map((b) => b.h));
  const fake = emptyBar(40 * 3_600_000, closes[39]);
  fake.o = closes[39]; fake.h = hi + 2; fake.l = closes[39] - 0.5; fake.c = hi - 2;
  const after = series([hi - 3, hi - 4, hi - 5]).map((b, i) => ({ ...b, t: (41 + i) * 3_600_000 }));
  const all = [...bars, fake, ...after];

  it("detects a confirmed 2B top after a failed breakout", () => {
    const s = detect2B(all);
    const top = s.filter((x) => x.kind === "top").at(-1)!;
    expect(top).toBeTruthy();
    expect(top.state).toBe("confirmed");
    expect(top.breakIdx).toBe(40);
    expect(top.extreme).toBeCloseTo(hi + 2);
    expect(top.invalidation).toBeGreaterThan(top.extreme);
  });

  it("marks it invalidated when price later exceeds the false-break extreme", () => {
    const up = series([hi + 5, hi + 6]).map((b, i) => ({ ...b, t: (44 + i) * 3_600_000 }));
    const top = detect2B([...all, ...up]).filter((x) => x.kind === "top").at(-1)!;
    // the latest top in this tape is the original one or a later pivot; the original must be invalidated
    const orig = detect2B([...all, ...up]).find((x) => x.breakIdx === 40)!;
    expect(orig.state).toBe("invalidated");
    expect(top).toBeTruthy();
  });

  it("does not use future bars: result at bar t is unchanged by appending bars", () => {
    const a = detect2B(all.slice(0, 41)).find((x) => x.breakIdx === 40)!;
    const b = detect2B(all).find((x) => x.breakIdx === 40)!;
    expect(a.confirmIdx).toBe(40); // the breakout bar itself closed back below the pivot
    expect([a.pivot.i, a.confirmIdx, a.extreme]).toEqual([b.pivot.i, b.confirmIdx, b.extreme]);
  });
});

describe("Gann fan", () => {
  it("1×1 rises one scale unit per bar from the pivot; 2×1 twice as fast", () => {
    const fan = { direction: "up" as const, pivot: { i: 10, t: 0, price: 100, kind: "low" as const, confirmedAt: 15 }, scale: 2 };
    expect(gannLevel(fan, 1, 15)).toBe(110);
    expect(gannLevel(fan, 2, 15)).toBe(120);
    expect(gannLevel({ ...fan, direction: "down" }, 0.5, 14)).toBe(96);
  });
  it("builds fans from the extreme pivots and locates price between angles", () => {
    const closes = [...Array(60)].map((_, i) => (i < 20 ? 120 - i : 100 + (i - 20) * 0.8));
    const f = gannFans(series(closes, 0.3), { k: 3 });
    expect(f.up?.pivot.kind).toBe("low");
    expect(f.up!.lines).toHaveLength(9);
    const [below, above] = f.up!.between;
    expect(below || above).toBeTruthy();
    const sorted = [...f.up!.lines].sort((a, b) => a.levelNow - b.levelNow).map((l) => l.label);
    expect(sorted[0]).toBe("1×8");
    expect(sorted[8]).toBe("8×1");
  });
});

describe("DVOL", () => {
  it("parses Deribit volatility index payloads and aggregates hours", () => {
    const h = 3_600_000;
    const rows = parseDvol({ result: { data: [[2 * h, 50, 52, 49, 51], [0, 48, 50, 47, 49], [h, 49, 55, 48, 50]] } });
    expect(rows.map((r) => r.t)).toEqual([0, h, 2 * h]);
    const agg = aggregateVol(rows, 4);
    expect(agg).toHaveLength(1);
    expect(agg[0]).toMatchObject({ o: 48, h: 55, l: 47, c: 51 });
  });
});

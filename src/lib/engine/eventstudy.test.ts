import { describe, expect, it } from "vitest";
import { emptyBar, type Bar } from "./bars";
import { detect2B, type VolBar } from "./technicals";
import { parseCboeVix, parseFredVix, vix2bEventStudy } from "./eventstudy";
import { mulberry32, gaussian } from "../core/stats";

const DAY = 86_400_000;

describe("VIX parsers", () => {
  it("parses CBOE VIX_History.csv (MM/DD/YYYY, OHLC) and drops bad rows", () => {
    const csv = "DATE,OPEN,HIGH,LOW,CLOSE\n01/03/2025,17.93,18.12,16.12,16.13\n01/02/2025,17.21,18.86,16.65,17.93\nbad,row\n01/06/2025,16.40,17.18,15.90,.\n";
    const v = parseCboeVix(csv);
    expect(v).toHaveLength(2);
    expect(v[0]).toEqual({ t: Date.UTC(2025, 0, 2), o: 17.21, h: 18.86, l: 16.65, c: 17.93 });
  });
  it("parses FRED VIXCLS skipping missing '.' values", () => {
    const v = parseFredVix({ observations: [{ date: "2025-01-02", value: "17.93" }, { date: "2025-01-03", value: "." }] });
    expect(v).toEqual([{ t: Date.UTC(2025, 0, 2), o: 17.93, h: 17.93, l: 17.93, c: 17.93 }]);
  });
});

/** Synthetic world: VIX random walk with periodic failed spikes; BTC random walk, optionally rallying after each failure. */
function world(effectBps: number, seed = 3) {
  const r = mulberry32(seed);
  const n = 700;
  const vix: VolBar[] = [];
  let v = 18;
  for (let i = 0; i < n; i++) {
    v = Math.max(10, v + gaussian(r) * 0.4 + (18 - v) * 0.05);
    let h = v + Math.abs(gaussian(r)) * 0.4, c = v;
    if (i % 40 === 39) { h = v + 9; c = v - 0.5; } // spike above recent swing high, close back below → 2B top
    vix.push({ t: i * DAY, o: v, h, l: v - Math.abs(gaussian(r)) * 0.4, c });
  }
  const tops = new Set(detect2B(vix, { k: 3, window: 3, minPenAtr: 0.1, lookback: 60 }).filter((s) => s.kind === "top" && s.confirmIdx !== null).map((s) => s.confirmIdx!));
  const btc: Bar[] = [];
  let p = 30_000, boost = 0;
  for (let i = 0; i < n; i++) {
    if (tops.has(i)) boost = 5;
    const drift = boost-- > 0 ? effectBps / 1e4 : 0;
    const o = p;
    p = p * Math.exp(drift + gaussian(r) * 0.02);
    const b = emptyBar(i * DAY, o);
    b.c = p; b.h = Math.max(o, p) * 1.01; b.l = Math.min(o, p) * 0.99;
    btc.push(b);
  }
  return { vix, btc, nTops: tops.size };
}

describe("VIX 2B event study", () => {
  it("detects a planted post-2B rally with a positive edge and small p-value", () => {
    const { vix, btc, nTops } = world(150);
    expect(nTops).toBeGreaterThan(8);
    const s = vix2bEventStudy(vix, btc)!;
    const h5 = s.top.find((x) => x.h === 5)!;
    expect(h5.n).toBeGreaterThan(8);
    expect(h5.edgeBps!).toBeGreaterThan(300);
    expect(h5.pValue!).toBeLessThan(0.05);
  });

  it("does not manufacture an effect when there is none", () => {
    const { vix, btc } = world(0, 11);
    const s = vix2bEventStudy(vix, btc)!;
    const h5 = s.top.find((x) => x.h === 5)!;
    expect(h5.pValue!).toBeGreaterThan(0.05);
  });

  it("enters at the BTC close of the VIX confirmation date (no look-ahead)", () => {
    const { vix, btc } = world(0, 5);
    const s = vix2bEventStudy(vix, btc)!;
    const e = s.events[0];
    const i = btc.findIndex((b) => b.t === e.vixDate);
    expect(e.btcEntry).toBe(btc[i].c);
    expect(e.fwd[1]).toBeCloseTo((btc[i + 1].c / btc[i].c - 1) * 1e4, 6);
  });
});

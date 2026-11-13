import { mulberry32 } from "../core/stats";
import type { Bar } from "./bars";
import { detect2B, type VolBar } from "./technicals";

/**
 * Cross-asset event study: what did BTC do after CBOE VIX 2B reversals?
 *
 * Point-in-time alignment: the VIX daily bar for date D closes ~20:15–21:15 UTC.
 * The earliest tradable BTC price after that is the BTC daily close of the same
 * UTC date (24:00 UTC), so entry = BTC close on D and nothing after D's VIX close is
 * used to define the event. All confirmed 2Bs are included, also those later
 * invalidated (excluding them would use future information).
 *
 * Significance: a permutation test against random BTC days from the same sample
 * (one-sided, in the hypothesis direction), plus the unconditional baseline.
 * Overlapping horizons and small n inflate apparent significance; the UI says so.
 */

export type VixResult =
  | { status: "ok"; source: string; ohlc: boolean; bars: VolBar[]; asOf: number }
  | { status: "unavailable"; reason: string; asOf: number };

/** Parse CBOE VIX_History.csv: "DATE,OPEN,HIGH,LOW,CLOSE" with MM/DD/YYYY dates. */
export function parseCboeVix(csv: string): VolBar[] {
  const out: VolBar[] = [];
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const [d, o, h, l, c] = line.split(",");
    if (!d || c === undefined) continue;
    const m = d.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) continue;
    const t = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]));
    const row = { t, o: Number(o), h: Number(h), l: Number(l), c: Number(c) };
    if ([row.o, row.h, row.l, row.c].every((x) => Number.isFinite(x) && x > 0)) out.push(row);
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Parse FRED VIXCLS observations (close only → o=h=l=c; 2B then works on closes). */
export function parseFredVix(json: { observations?: { date: string; value: string }[] }): VolBar[] {
  return (json.observations ?? [])
    .filter((o) => o.value !== "." && Number.isFinite(Number(o.value)))
    .map((o) => { const v = Number(o.value); return { t: Date.parse(`${o.date}T00:00:00Z`), o: v, h: v, l: v, c: v }; })
    .sort((a, b) => a.t - b.t);
}

export interface HorizonStat {
  h: number; // days
  n: number;
  mean: number | null; // bps
  median: number | null;
  hit: number | null; // share in hypothesis direction
  baselineMean: number | null;
  baselineHit: number | null;
  edgeBps: number | null; // mean − baseline mean (signed toward hypothesis)
  pValue: number | null; // permutation, one-sided
}

export interface EventStudy {
  events: { kind: "top" | "bottom"; vixDate: number; btcEntry: number; fwd: Record<number, number | null>; laterInvalidated: boolean }[];
  top: HorizonStat[];
  bottom: HorizonStat[];
  sample: { from: number; to: number; btcDays: number; vixDays: number };
  notes: string[];
}

const DAY = 86_400_000;

export function vix2bEventStudy(vix: VolBar[], btcDaily: Bar[], horizons = [1, 3, 5, 10], seed = 7, draws = 2000): EventStudy | null {
  if (vix.length < 60 || btcDaily.length < 60) return null;
  const from = Math.max(vix[0].t, btcDaily[0].t), to = Math.min(vix[vix.length - 1].t, btcDaily[btcDaily.length - 1].t);
  const vx = vix.filter((v) => v.t >= from - 120 * DAY && v.t <= to);
  const btcIdx = new Map(btcDaily.map((b, i) => [Math.floor(b.t / DAY) * DAY, i]));
  const sigs = detect2B(vx, { k: 3, window: 3, minPenAtr: 0.1, lookback: 60 }).filter((s) => s.confirmTime !== null && s.confirmTime >= from);
  const fwdFrom = (i: number, h: number) => (i + h < btcDaily.length ? (btcDaily[i + h].c / btcDaily[i].c - 1) * 10_000 : null);

  const events: EventStudy["events"] = [];
  for (const s of sigs) {
    const day = Math.floor(s.confirmTime! / DAY) * DAY;
    const i = btcIdx.get(day);
    if (i === undefined) continue;
    const fwd: Record<number, number | null> = {};
    for (const h of horizons) fwd[h] = fwdFrom(i, h);
    events.push({ kind: s.kind, vixDate: day, btcEntry: btcDaily[i].c, fwd, laterInvalidated: s.state === "invalidated" });
  }

  // baseline: every BTC day in the overlapping sample
  const sampleIdx: number[] = [];
  for (let i = 0; i < btcDaily.length; i++) if (btcDaily[i].t >= from && btcDaily[i].t <= to) sampleIdx.push(i);
  const rand = mulberry32(seed);

  const stats = (kind: "top" | "bottom"): HorizonStat[] => {
    const dir = kind === "top" ? 1 : -1; // top → bullish BTC hypothesis; bottom → bearish
    return horizons.map((h) => {
      const xs = events.filter((e) => e.kind === kind).map((e) => e.fwd[h]).filter((x): x is number => x !== null);
      const base = sampleIdx.map((i) => fwdFrom(i, h)).filter((x): x is number => x !== null);
      if (!xs.length || base.length < 30) return { h, n: xs.length, mean: null, median: null, hit: null, baselineMean: null, baselineHit: null, edgeBps: null, pValue: null };
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      const so = [...xs].sort((a, b) => a - b);
      const bMean = base.reduce((a, b) => a + b, 0) / base.length;
      let ge = 0;
      for (let d = 0; d < draws; d++) {
        let s = 0;
        for (let k = 0; k < xs.length; k++) s += base[Math.floor(rand() * base.length)];
        if ((s / xs.length) * dir >= mean * dir) ge++;
      }
      return {
        h, n: xs.length, mean, median: so[Math.floor(so.length / 2)],
        hit: xs.filter((x) => x * dir > 0).length / xs.length,
        baselineMean: bMean, baselineHit: base.filter((x) => x * dir > 0).length / base.length,
        edgeBps: (mean - bMean) * dir,
        pValue: (ge + 1) / (draws + 1),
      };
    });
  };

  return {
    events: events.slice(-40).reverse(),
    top: stats("top"),
    bottom: stats("bottom"),
    sample: { from, to, btcDays: sampleIdx.length, vixDays: vx.length },
    notes: [
      "Entry = BTC daily close on the VIX confirmation date (after the US cash close) — no look-ahead.",
      "All confirmed 2Bs are counted, including ones later invalidated.",
      "p-value: permutation vs random BTC days in the same sample, one-sided in the hypothesis direction; overlapping horizons and multiple horizons tested inflate significance.",
      "Before costs. Correlation regimes change (BTC–equity linkage strengthened after 2020).",
    ],
  };
}

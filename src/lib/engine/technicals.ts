import type { Bar } from "./bars";
import { atr } from "./bars";

/**
 * Classic technical frameworks, implemented point-in-time and labeled as INFERRED
 * heuristics. None of these feed evidence-strength scores as "proof"; they are
 * context with explicit assumptions.
 *
 *  • Williams VIX Fix (WVF) — a synthetic fear gauge from price alone:
 *      WVF_t = (max(close_{t-n+1..t}) − low_t) / max(close_{t-n+1..t}) × 100   (n = 22)
 *  • Swing pivots — fractal highs/lows with k bars each side. A pivot at i is only
 *    known at i+k (confirmation lag), so nothing here uses future bars.
 *  • 2B reversal (Victor Sperandeo) — price (or volatility) exceeds the prior confirmed
 *    swing extreme, then closes back inside it within W bars: the breakout failed.
 *      VIX 2B top    = fear spike fails  → historically a bullish context for the asset.
 *      VIX 2B bottom = complacency breaks → volatility-expansion risk (non-directional).
 *  • Gann fan — lines from a pivot at fixed price/time ratios (8×1 … 1×8). The 1×1
 *    "unit" (price per bar) is an arbitrary scale; we make it explicit and selectable.
 */

export interface VolBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface Pivot {
  i: number; // bar index
  t: number;
  price: number;
  kind: "high" | "low";
  confirmedAt: number; // index at which the pivot became known (i + k)
}

/** Williams VIX Fix as an OHLC-like series (h = wvf on the bar low, l = wvf on the bar high). */
export function williamsVixFix(bars: Bar[], n = 22): VolBar[] {
  const out: VolBar[] = [];
  for (let i = 0; i < bars.length; i++) {
    let hc = -Infinity;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) hc = Math.max(hc, bars[j].c);
    if (!(hc > 0)) continue;
    const v = (x: number) => Math.max(0, ((hc - x) / hc) * 100);
    out.push({ t: bars[i].t, o: v(bars[i].o), h: v(bars[i].l), l: v(bars[i].h), c: v(bars[i].c) });
  }
  return out;
}

/** WVF spike state: above Bollinger upper band (20, 2σ) or above 85% of the 50-bar range high (Williams). */
export function wvfState(series: VolBar[], bbLen = 20, mult = 2, lb = 50, ph = 0.85) {
  const n = series.length;
  if (n < Math.max(bbLen, lb) + 1) return null;
  const vals = series.map((s) => s.h);
  const win = vals.slice(n - bbLen);
  const mid = win.reduce((a, b) => a + b, 0) / bbLen;
  const sd = Math.sqrt(win.reduce((a, b) => a + (b - mid) ** 2, 0) / bbLen);
  const upper = mid + mult * sd;
  const rangeHigh = Math.max(...vals.slice(n - lb)) * ph;
  const cur = vals[n - 1];
  const hist = vals.slice(Math.max(0, n - 500));
  const pct = hist.filter((x) => x < cur).length / hist.length;
  return { value: cur, mid, upper, rangeHigh, percentile: pct, spike: cur >= upper || cur >= rangeHigh };
}

/** Fractal swing pivots (k bars each side). Only pivots confirmed by `upto` (inclusive) are returned. */
export function swings(highs: number[], lows: number[], times: number[], k = 3, upto = highs.length - 1): Pivot[] {
  const out: Pivot[] = [];
  for (let i = k; i + k <= upto; i++) {
    let isH = true, isL = true;
    // ties: strictly beyond the left side, at least equal to the right side (one pivot per flat top/bottom)
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (j < i ? highs[j] >= highs[i] : highs[j] > highs[i]) isH = false;
      if (j < i ? lows[j] <= lows[i] : lows[j] < lows[i]) isL = false;
    }
    if (isH) out.push({ i, t: times[i], price: highs[i], kind: "high", confirmedAt: i + k });
    if (isL) out.push({ i, t: times[i], price: lows[i], kind: "low", confirmedAt: i + k });
  }
  return out;
}

export type TwoBState = "pending" | "confirmed" | "invalidated" | "expired";

export interface TwoB {
  kind: "top" | "bottom"; // top = failed breakout above prior swing high
  pivot: Pivot; // the swing extreme that was exceeded
  breakIdx: number; // bar that first exceeded the pivot
  breakTime: number;
  extreme: number; // most extreme value reached during the false breakout
  confirmIdx: number | null; // bar whose close returned inside the pivot
  confirmTime: number | null;
  state: TwoBState;
  /** invalidation: the false-breakout extreme (+/− buffer) */
  invalidation: number;
  /** trigger: the pivot level (close back through it) */
  trigger: number;
  barsAgo: number;
}

/**
 * Detect 2B tops and bottoms on an OHLC series, scanning forward bar by bar using only
 * pivots confirmed at that time.
 *  window   — bars allowed between the breakout and the failure close (Sperandeo: 1–3, we default 3)
 *  minPen   — minimum penetration beyond the pivot, as a fraction of ATR (filters 1-tick pokes)
 *  lookback — pivots older than this many bars are ignored
 */
export function detect2B(s: { t: number; h: number; l: number; c: number }[], opts: { k?: number; window?: number; minPenAtr?: number; lookback?: number; bufferAtr?: number } = {}): TwoB[] {
  const k = opts.k ?? 3, W = opts.window ?? 3, minPen = opts.minPenAtr ?? 0.1, lb = opts.lookback ?? 60, buf = opts.bufferAtr ?? 0.1;
  const n = s.length;
  if (n < 30) return [];
  const H = s.map((x) => x.h), L = s.map((x) => x.l), T = s.map((x) => x.t);
  const allPiv = swings(H, L, T, k);
  // ATR on this series (works for vol indices too)
  const tr: number[] = s.map((x, i) => (i ? Math.max(x.h - x.l, Math.abs(x.h - s[i - 1].c), Math.abs(x.l - s[i - 1].c)) : x.h - x.l));
  const atrAt = (i: number) => { const a = tr.slice(Math.max(0, i - 13), i + 1); return a.reduce((p, q) => p + q, 0) / a.length; };
  const out: TwoB[] = [];
  const used = new Set<string>();
  for (let b = k + 1; b < n; b++) {
    const known = allPiv.filter((p) => p.confirmedAt < b && b - p.i <= lb);
    const lastHigh = [...known].reverse().find((p) => p.kind === "high");
    const lastLow = [...known].reverse().find((p) => p.kind === "low");
    const a = atrAt(b);
    for (const piv of [lastHigh, lastLow]) {
      if (!piv) continue;
      const key = `${piv.kind}:${piv.i}`;
      if (used.has(key)) continue;
      const top = piv.kind === "high";
      const pen = top ? s[b].h - piv.price : piv.price - s[b].l;
      if (pen < minPen * a) continue;
      used.add(key);
      // track the false breakout for up to W bars
      let extreme = top ? s[b].h : s[b].l;
      let confirmIdx: number | null = null;
      for (let j = b; j < Math.min(n, b + W); j++) {
        extreme = top ? Math.max(extreme, s[j].h) : Math.min(extreme, s[j].l);
        if (top ? s[j].c < piv.price : s[j].c > piv.price) { confirmIdx = j; break; }
      }
      const invalidation = top ? extreme + buf * a : extreme - buf * a;
      let state: TwoBState;
      if (confirmIdx === null) state = b + W > n - 1 ? "pending" : "expired";
      else {
        state = "confirmed";
        for (let j = confirmIdx + 1; j < n; j++) if (top ? s[j].h > invalidation : s[j].l < invalidation) { state = "invalidated"; break; }
      }
      out.push({ kind: top ? "top" : "bottom", pivot: piv, breakIdx: b, breakTime: s[b].t, extreme, confirmIdx, confirmTime: confirmIdx !== null ? s[confirmIdx].t : null, state, invalidation, trigger: piv.price, barsAgo: n - 1 - (confirmIdx ?? b) });
    }
  }
  return out;
}

// ------------------------------------------------------------------ Gann fan

export const GANN_RATIOS: { label: string; r: number }[] = [
  { label: "8×1", r: 8 }, { label: "4×1", r: 4 }, { label: "3×1", r: 3 }, { label: "2×1", r: 2 },
  { label: "1×1", r: 1 },
  { label: "1×2", r: 1 / 2 }, { label: "1×3", r: 1 / 3 }, { label: "1×4", r: 1 / 4 }, { label: "1×8", r: 1 / 8 },
];

export type GannScaleMode = "atr" | "pivot";

export interface GannFan {
  direction: "up" | "down"; // up = from a swing low, rising lines
  pivot: Pivot;
  scale: number; // price units per bar for the 1×1
  scaleMode: GannScaleMode;
  barMs: number;
  lines: { label: string; r: number; levelNow: number; levelAhead: number }[];
  /** price position: index of the angle just below (up fan) / above (down fan) current price */
  between: [string | null, string | null];
  aboveOneByOne: boolean;
  /** angles price crossed (close-to-close) in the last 3 bars */
  recentBreaks: { label: string; dir: "up" | "down"; barsAgo: number }[];
  nearestSupport: { label: string; price: number } | null;
  nearestResistance: { label: string; price: number } | null;
  aheadBars: number;
}

/** Level of a fan line `r` at bar index j. */
export function gannLevel(fan: { direction: "up" | "down"; pivot: Pivot; scale: number }, r: number, j: number) {
  const dt = j - fan.pivot.i;
  return fan.direction === "up" ? fan.pivot.price + r * fan.scale * dt : fan.pivot.price - r * fan.scale * dt;
}

/**
 * Build Gann fans from the most significant swing low (up fan) and swing high (down fan)
 * among confirmed pivots in the last `lookback` bars.
 *  scaleMode "atr":   1×1 = ATR(14) per bar (volatility-normalized)
 *  scaleMode "pivot": 1×1 passes through the opposite major pivot (range ÷ bars between them)
 */
export function gannFans(bars: Bar[], opts: { lookback?: number; k?: number; scaleMode?: GannScaleMode; aheadBars?: number } = {}): { up: GannFan | null; down: GannFan | null } {
  const lookback = opts.lookback ?? 150, k = opts.k ?? 5, mode = opts.scaleMode ?? "atr", ahead = opts.aheadBars ?? 20;
  const n = bars.length;
  if (n < 40) return { up: null, down: null };
  const barMs = bars[n - 1].t - bars[n - 2].t;
  const piv = swings(bars.map((b) => b.h), bars.map((b) => b.l), bars.map((b) => b.t), k).filter((p) => n - 1 - p.i <= lookback);
  const lows = piv.filter((p) => p.kind === "low"), highs = piv.filter((p) => p.kind === "high");
  const lo = lows.length ? lows.reduce((a, b) => (b.price < a.price ? b : a)) : null;
  const hi = highs.length ? highs.reduce((a, b) => (b.price > a.price ? b : a)) : null;
  const a = atr(bars, 14);
  const build = (pivot: Pivot | null, direction: "up" | "down"): GannFan | null => {
    if (!pivot || !a || pivot.i >= n - 2) return null;
    let scale = a;
    if (mode === "pivot") {
      const opp = direction === "up" ? hi : lo;
      if (opp && opp.i !== pivot.i && Math.abs(opp.i - pivot.i) >= 3) scale = Math.abs(opp.price - pivot.price) / Math.abs(opp.i - pivot.i);
    }
    const fan = { direction, pivot, scale };
    const last = n - 1;
    const px = bars[last].c;
    const lines = GANN_RATIOS.map((g) => ({ label: g.label, r: g.r, levelNow: gannLevel(fan, g.r, last), levelAhead: gannLevel(fan, g.r, last + ahead) }));
    // lines sorted by level now
    const sorted = [...lines].sort((x, y) => x.levelNow - y.levelNow);
    const below = [...sorted].reverse().find((l) => l.levelNow <= px) ?? null;
    const above = sorted.find((l) => l.levelNow > px) ?? null;
    const recentBreaks: GannFan["recentBreaks"] = [];
    for (let j = Math.max(pivot.i + 1, last - 2); j <= last; j++) {
      for (const g of GANN_RATIOS) {
        const l0 = gannLevel(fan, g.r, j - 1), l1 = gannLevel(fan, g.r, j);
        if (bars[j - 1].c >= l0 && bars[j].c < l1) recentBreaks.push({ label: g.label, dir: "down", barsAgo: last - j });
        if (bars[j - 1].c <= l0 && bars[j].c > l1) recentBreaks.push({ label: g.label, dir: "up", barsAgo: last - j });
      }
    }
    return {
      direction, pivot, scale, scaleMode: mode, barMs, lines,
      between: [below?.label ?? null, above?.label ?? null],
      aboveOneByOne: px > gannLevel(fan, 1, last),
      recentBreaks,
      nearestSupport: below ? { label: below.label, price: below.levelNow } : null,
      nearestResistance: above ? { label: above.label, price: above.levelNow } : null,
      aheadBars: ahead,
    };
  };
  return { up: build(lo, "up"), down: build(hi, "down") };
}

/** Forward outcome of past confirmed 2B signals on the same series (in-sample, descriptive). */
export function twoBOutcomes(s: { t: number; c: number }[], signals: TwoB[], horizon = 10) {
  const res = { top: [] as number[], bottom: [] as number[] };
  for (const x of signals) {
    if (x.confirmIdx === null || x.confirmIdx + horizon >= s.length) continue;
    const r = (s[x.confirmIdx + horizon].c / s[x.confirmIdx].c - 1) * 10_000;
    res[x.kind].push(r);
  }
  const summ = (v: number[]) => {
    if (!v.length) return { n: 0, median: null as number | null, hit: null as number | null };
    const so = [...v].sort((a, b) => a - b);
    return { n: v.length, median: so[Math.floor(so.length / 2)], hit: null as number | null };
  };
  const top = summ(res.top), bottom = summ(res.bottom);
  if (top.n) top.hit = res.top.filter((x) => x < 0).length / top.n; // top predicts down
  if (bottom.n) bottom.hit = res.bottom.filter((x) => x > 0).length / bottom.n;
  return { top, bottom, horizon };
}

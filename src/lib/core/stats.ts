/** Robust, allocation-light statistics used across the engine. */

export class RingBuffer {
  private buf: Float64Array;
  private head = 0;
  private n = 0;
  constructor(readonly capacity: number) {
    this.buf = new Float64Array(capacity);
  }
  push(x: number) {
    this.buf[this.head] = x;
    this.head = (this.head + 1) % this.capacity;
    if (this.n < this.capacity) this.n++;
  }
  get length() {
    return this.n;
  }
  /** i=0 oldest */
  at(i: number) {
    return this.buf[(this.head - this.n + i + this.capacity * 2) % this.capacity];
  }
  last(k = 0) {
    return this.n ? this.at(this.n - 1 - k) : NaN;
  }
  toArray(): number[] {
    const out = new Array(this.n);
    for (let i = 0; i < this.n; i++) out[i] = this.at(i);
    return out;
  }
  clear() {
    this.n = 0;
    this.head = 0;
  }
}

export function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function quantile(xs: number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** Median absolute deviation scaled to be a consistent estimator of sigma under normality. */
export function mad(xs: number[]): number {
  const m = median(xs);
  return 1.4826 * median(xs.map((x) => Math.abs(x - m)));
}

/**
 * Robust z-score: (x - median) / (1.4826 * MAD). Clipped to ±6 to bound influence.
 * Returns null when history is too short or degenerate — never a fabricated 0.
 */
export function robustZ(x: number, history: number[], minN = 20): number | null {
  if (history.length < minN || !Number.isFinite(x)) return null;
  const m = median(history);
  let s = mad(history);
  if (!(s > 0)) {
    // fall back to std when MAD collapses (e.g. many identical values)
    const mean = history.reduce((a, b) => a + b, 0) / history.length;
    s = Math.sqrt(history.reduce((a, b) => a + (b - mean) ** 2, 0) / history.length);
    if (!(s > 0)) return null;
  }
  return clamp((x - m) / s, -6, 6);
}

/** Empirical percentile rank of x within history, in [0,1]. */
export function percentileRank(x: number, history: number[], minN = 20): number | null {
  if (history.length < minN) return null;
  let below = 0, equal = 0;
  for (const h of history) { if (h < x) below++; else if (h === x) equal++; }
  return (below + 0.5 * equal) / history.length;
}

export function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

/** Logistic squashing of a z-like score into (0,1). */
export function squash(z: number, k = 1) {
  return 1 / (1 + Math.exp(-k * z));
}

export class Ewma {
  value: number | null = null;
  constructor(readonly alpha: number) {}
  update(x: number) {
    this.value = this.value === null ? x : this.alpha * x + (1 - this.alpha) * this.value;
    return this.value;
  }
  static fromHalfLife(n: number) {
    return new Ewma(1 - Math.exp(Math.log(0.5) / n));
  }
}

/** OLS slope & r² of y on x. */
export function linreg(xs: number[], ys: number[]) {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] ** 2; sxy += xs[i] * ys[i]; syy += ys[i] ** 2; }
  const den = n * sxx - sx * sx;
  if (den === 0) return null;
  const slope = (n * sxy - sx * sy) / den;
  const intercept = (sy - slope * sx) / n;
  const ssTot = syy - (sy * sy) / n;
  let ssRes = 0;
  for (let i = 0; i < n; i++) ssRes += (ys[i] - (intercept + slope * xs[i])) ** 2;
  return { slope, intercept, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0, n };
}

export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); dx += (xs[i] - mx) ** 2; dy += (ys[i] - my) ** 2; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
}

/** Realized volatility (stdev of log returns) of a price series. */
export function realizedVol(prices: number[]): number | null {
  if (prices.length < 3) return null;
  const r: number[] = [];
  for (let i = 1; i < prices.length; i++) if (prices[i - 1] > 0) r.push(Math.log(prices[i] / prices[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, r.length - 1));
}

/** Deterministic PRNG (mulberry32) — reproducible simulations and Monte Carlo. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand: () => number) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf). */
export function normCdf(x: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

export function normPdf(x: number) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

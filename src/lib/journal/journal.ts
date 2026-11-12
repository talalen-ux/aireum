/**
 * Forecast journal & calibration. Rewards analytical discipline and calibration —
 * never leverage, volume, frequency or PnL.
 */
export interface Forecast {
  id: string;
  createdAt: number;
  asset: "BTC" | "ETH";
  mode: "live" | "simulation" | "replay";
  direction: "up" | "down";
  horizonMin: number;
  /** stated probability that price is in `direction` at horizon, 0.5–0.99 */
  prob: number;
  priceAt: number;
  invalidation: number | null;
  counterArgument: string;
  rationale: string;
  resolvedAt?: number;
  priceAtResolve?: number;
  outcome?: 0 | 1;
}

export function resolve(f: Forecast, price: number, now: number): Forecast {
  if (f.outcome !== undefined || now < f.createdAt + f.horizonMin * 60_000) return f;
  const up = price > f.priceAt;
  return { ...f, resolvedAt: now, priceAtResolve: price, outcome: (f.direction === "up") === up ? 1 : 0 };
}

export function brier(fs: Forecast[]): number | null {
  const r = fs.filter((f) => f.outcome !== undefined);
  if (!r.length) return null;
  return r.reduce((a, f) => a + (f.prob - (f.outcome as number)) ** 2, 0) / r.length;
}

export function reliability(fs: Forecast[], bins = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0001]) {
  const r = fs.filter((f) => f.outcome !== undefined);
  return bins.slice(0, -1).map((lo, i) => {
    const hi = bins[i + 1];
    const inBin = r.filter((f) => f.prob >= lo && f.prob < hi);
    return { lo, hi, n: inBin.length, stated: inBin.length ? inBin.reduce((a, f) => a + f.prob, 0) / inBin.length : null, observed: inBin.length ? inBin.reduce((a, f) => a + (f.outcome as number), 0) / inBin.length : null };
  });
}

export interface Badge { id: string; name: string; desc: string; earned: boolean; progress: string }

export function badges(fs: Forecast[], counterNotes: number): Badge[] {
  const resolved = fs.filter((f) => f.outcome !== undefined);
  const withInval = fs.filter((f) => f.invalidation !== null).length;
  const withCounter = fs.filter((f) => f.counterArgument.trim().length >= 20).length;
  const sides = new Set(fs.map((f) => f.direction));
  const b = brier(fs);
  const days = new Map<string, number>();
  for (const f of fs) { const d = new Date(f.createdAt).toISOString().slice(0, 10); days.set(d, (days.get(d) ?? 0) + 1); }
  const maxPerDay = Math.max(0, ...days.values());
  return [
    { id: "invalidation", name: "Risk Architect", desc: "10 forecasts, each with an explicit invalidation level", earned: withInval >= 10, progress: `${Math.min(withInval, 10)}/10` },
    { id: "counter", name: "Devil's Advocate", desc: "10 forecasts with a written strongest counterargument", earned: withCounter >= 10, progress: `${Math.min(withCounter, 10)}/10` },
    { id: "symmetric", name: "Symmetric Thinker", desc: "Logged both up and down hypotheses", earned: sides.size === 2, progress: `${sides.size}/2 sides` },
    { id: "calibrated", name: "Calibrated", desc: "Brier score ≤ 0.22 over ≥ 20 resolved forecasts", earned: resolved.length >= 20 && (b ?? 1) <= 0.22, progress: `${resolved.length}/20 · Brier ${b?.toFixed(3) ?? "—"}` },
    { id: "patience", name: "Patience", desc: "Never more than 5 forecasts in a day (≥ 10 total) — quality over frequency", earned: fs.length >= 10 && maxPerDay <= 5, progress: `${fs.length}/10 · max/day ${maxPerDay}` },
    { id: "detective", name: "Market Detective", desc: "Annotated 5 radar hypotheses with your own counter-evidence", earned: counterNotes >= 5, progress: `${Math.min(counterNotes, 5)}/5` },
  ];
}

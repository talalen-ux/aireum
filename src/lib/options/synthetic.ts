/**
 * SIMULATION ONLY — deterministic synthetic option chain for offline demos and tests.
 * Values are generated from a parametric smile/term structure, NOT from any market.
 * The UI must label this as SIMULATION wherever it is shown.
 */
import { mulberry32 } from "@/lib/core/stats";
import { bsPrice, yearsBetween } from "./blackscholes";
import type { OptionAsset, OptionChain, OptionRow } from "./types";

const DAY = 86_400_000;

function niceStep(x: number) {
  const p = 10 ** Math.floor(Math.log10(x));
  const m = x / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2.5 : m < 7.5 ? 5 : 10) * p;
}

function nextFriday0800(from: number) {
  const d = new Date(from);
  d.setUTCHours(8, 0, 0, 0);
  while (d.getUTCDay() !== 5 || d.getTime() <= from) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

function syntheticExpiries(now: number) {
  const out = new Set<number>();
  const d0 = new Date(now);
  d0.setUTCHours(8, 0, 0, 0);
  let t = d0.getTime() <= now ? d0.getTime() + DAY : d0.getTime();
  for (let i = 0; i < 3; i++, t += DAY) out.add(t); // dailies
  let f = nextFriday0800(now);
  for (let i = 0; i < 4; i++, f += 7 * DAY) out.add(f); // weeklies
  for (let m = 1; m <= 6; m++) {
    // last Friday of the following months
    const d = new Date(now);
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + m + 1, 0, 8));
    while (end.getUTCDay() !== 5) end.setUTCDate(end.getUTCDate() - 1);
    if (m <= 3 || end.getUTCMonth() % 3 === 2) out.add(end.getTime());
  }
  return [...out].filter((e) => e > now).sort((a, b) => a - b);
}

/** Deterministic for a given (asset, rounded spot, hour bucket). */
export function syntheticChain(asset: OptionAsset, spot: number, nowMs: number): OptionChain {
  const now = Math.floor(nowMs / 3_600_000) * 3_600_000;
  const rand = mulberry32(Math.round(spot / niceStep(spot * 0.01)) * 7919 + (asset === "BTC" ? 1 : 2) + Math.floor(now / DAY));
  const step = niceStep(spot * 0.02);
  const baseVol = asset === "BTC" ? 0.5 : 0.65;
  const rows: OptionRow[] = [];
  for (const expiry of syntheticExpiries(now)) {
    const T = yearsBetween(now, expiry);
    const atm = baseVol + 0.06 * Math.log(1 + T * 4) - 0.04 * Math.exp(-T * 50);
    const F = spot * (1 + 0.08 * T); // contango basis
    const width = Math.max(0.12, Math.min(0.8, 3 * atm * Math.sqrt(T)));
    const lo = Math.ceil((spot * (1 - width)) / step) * step;
    const hi = Math.floor((spot * (1 + width)) / step) * step;
    const termOi = (asset === "BTC" ? 9000 : 90000) * Math.exp(-((Math.log(T * 365) - 3.3) ** 2) / 4);
    for (let K = lo; K <= hi; K += step) {
      const k = Math.log(K / F) / Math.max(Math.sqrt(T), 0.05);
      const iv = Math.max(0.15, atm - 0.06 * k + 0.035 * k * k);
      const round = K % (step * 5) === 0 ? 2.2 : 1;
      for (const type of ["C", "P"] as const) {
        const otm = type === "C" ? K >= spot : K <= spot;
        const side = type === "C" ? Math.exp(-((Math.log(K / spot) - 0.08) ** 2) / 0.02) : Math.exp(-((Math.log(K / spot) + 0.1) ** 2) / 0.025);
        const oi = termOi * side * round * (otm ? 1 : 0.35) * (0.6 + 0.8 * rand()) / 20;
        const priceUsd = bsPrice({ S: F, K, T, sigma: iv, type });
        rows.push({
          instrument: `${asset}-SIM-${new Date(expiry).toISOString().slice(0, 10)}-${K}-${type}`,
          expiry,
          strike: K,
          type,
          oi: Math.round(oi * 10) / 10,
          volume: Math.round(oi * (0.05 + 0.25 * rand()) * 10) / 10,
          markIv: iv,
          bidIv: iv - 0.01,
          askIv: iv + 0.01,
          delta: null,
          underlyingPrice: F,
          markPrice: priceUsd / F,
        });
      }
    }
  }
  return {
    status: "ok",
    asset,
    asOf: nowMs,
    underlying: spot,
    rows,
    source: "atlas.sim.options",
    provenance: "simulated",
    mode: "simulation",
    licensing: "SIMULATION — synthetic data generated locally; not market data.",
  };
}

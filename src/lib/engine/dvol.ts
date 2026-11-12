import type { Asset } from "../core/types";
import type { VolBar } from "./technicals";

/**
 * Deribit DVOL — the crypto analogue of VIX (30-day implied volatility index from the
 * BTC/ETH option surface). Public endpoint, no key. On failure we return
 * `unavailable` and the UI falls back to the price-derived Williams VIX Fix.
 */
export type DvolResult =
  | { status: "ok"; asset: Asset; h1: VolBar[]; d1: VolBar[]; asOf: number; source: string }
  | { status: "unavailable"; reason: string; asOf: number };

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function parseDvol(json: unknown): VolBar[] {
  const data = (json as { result?: { data?: number[][] } })?.result?.data;
  if (!Array.isArray(data)) throw new Error("unexpected DVOL payload");
  return data
    .filter((r) => Array.isArray(r) && r.length >= 5 && r.every((x) => Number.isFinite(x)))
    .map(([t, o, h, l, c]) => ({ t, o, h, l, c }))
    .sort((a, b) => a.t - b.t);
}

async function series(f: Fetch, asset: Asset, resolution: string, spanMs: number, now: number) {
  const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${asset}&start_timestamp=${now - spanMs}&end_timestamp=${now}&resolution=${resolution}`;
  const r = await f(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return parseDvol(await r.json());
}

export async function fetchDvol(asset: Asset, fetchImpl: Fetch = fetch as unknown as Fetch, now = Date.now()): Promise<DvolResult> {
  try {
    const [h1, d1] = await Promise.all([series(fetchImpl, asset, "3600", 45 * 86_400_000, now), series(fetchImpl, asset, "1D", 400 * 86_400_000, now)]);
    if (!h1.length && !d1.length) return { status: "unavailable", reason: "DVOL returned no data", asOf: now };
    return { status: "ok", asset, h1, d1, asOf: now, source: "deribit.public.get_volatility_index_data" };
  } catch (e) {
    return { status: "unavailable", reason: `Deribit DVOL unreachable (${(e as Error).message})`, asOf: now };
  }
}

/** Aggregate hourly DVOL bars to `hours`-hour bars aligned to UTC. */
export function aggregateVol(bars: VolBar[], hours: number): VolBar[] {
  const ms = hours * 3_600_000;
  const out: VolBar[] = [];
  for (const b of bars) {
    const t = Math.floor(b.t / ms) * ms;
    const last = out[out.length - 1];
    if (last && last.t === t) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; }
    else out.push({ ...b, t });
  }
  return out;
}

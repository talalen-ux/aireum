/**
 * Deribit public options data (REST, no credentials).
 *
 * Endpoints:
 *  - /api/v2/public/get_book_summary_by_currency?currency=BTC&kind=option
 *  - /api/v2/public/get_index_price?index_name=btc_usd
 *
 * Deribit market data is public but subject to Deribit's API terms; redistribution
 * of raw data to third parties may require a license. ATLAS only renders derived
 * analytics for the connected user and never re-publishes raw feeds.
 */
import type { ChainResult, OptionAsset, OptionChain, OptionRow } from "./types";

export const DERIBIT_BASE = "https://www.deribit.com";
export const DERIBIT_OPTIONS_POLL_MS = 60_000;
export const DERIBIT_LICENSING =
  "Source: Deribit public API. Derived analytics for personal use; raw data redistribution may require a Deribit license.";

const MONTHS: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

export interface ParsedInstrument {
  asset: string;
  expiry: number;
  strike: number;
  type: "C" | "P";
}

/**
 * Parse a Deribit option instrument name, e.g. `BTC-27DEC24-100000-C`.
 * Decimal strikes use `d` (e.g. `XRP_USDC-30JUN25-2d5-C`). Expiry is 08:00 UTC.
 */
export function parseInstrument(name: string): ParsedInstrument | null {
  const m = /^([A-Z0-9_]+)-(\d{1,2})([A-Z]{3})(\d{2})-([0-9d.]+)-([CP])$/.exec(name);
  if (!m) return null;
  const month = MONTHS[m[3]];
  if (month === undefined) return null;
  const day = Number(m[2]);
  const year = 2000 + Number(m[4]);
  const strike = Number(m[5].replace("d", "."));
  if (!Number.isFinite(strike) || strike <= 0) return null;
  return { asset: m[1], expiry: Date.UTC(year, month, day, 8, 0, 0), strike, type: m[6] as "C" | "P" };
}

interface DeribitSummary {
  instrument_name: string;
  open_interest?: number | null;
  volume?: number | null;
  mark_iv?: number | null;
  bid_iv?: number | null;
  ask_iv?: number | null;
  underlying_price?: number | null;
  mark_price?: number | null;
  greeks?: { delta?: number } | null;
}

const ivFrac = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v / 100 : null);

/** Normalize a raw get_book_summary_by_currency result into option rows. Pure — unit-testable. */
export function parseBookSummary(items: DeribitSummary[], nowMs: number): OptionRow[] {
  const rows: OptionRow[] = [];
  for (const it of items) {
    const p = parseInstrument(it.instrument_name);
    if (!p || p.expiry <= nowMs) continue;
    rows.push({
      instrument: it.instrument_name,
      expiry: p.expiry,
      strike: p.strike,
      type: p.type,
      oi: Number(it.open_interest) || 0,
      volume: Number(it.volume) || 0,
      markIv: ivFrac(it.mark_iv),
      bidIv: ivFrac(it.bid_iv),
      askIv: ivFrac(it.ask_iv),
      delta: it.greeks?.delta ?? null,
      underlyingPrice: typeof it.underlying_price === "number" && it.underlying_price > 0 ? it.underlying_price : null,
      markPrice: typeof it.mark_price === "number" ? it.mark_price : null,
    });
  }
  rows.sort((a, b) => a.expiry - b.expiry || a.strike - b.strike || a.type.localeCompare(b.type));
  return rows;
}

async function getJson(url: string, signal?: AbortSignal) {
  const res = await fetch(url, { signal, headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  if (j?.error) throw new Error(j.error.message ?? "API error");
  return j.result;
}

/** Fetch the full public option chain. Degrades to `unavailable` — never invents values. */
export async function fetchDeribitChain(asset: OptionAsset, opts: { signal?: AbortSignal; base?: string } = {}): Promise<ChainResult> {
  const base = opts.base ?? DERIBIT_BASE;
  const source = "deribit.rest.get_book_summary_by_currency";
  const asOf = Date.now();
  try {
    const [summary, index] = await Promise.all([
      getJson(`${base}/api/v2/public/get_book_summary_by_currency?currency=${asset}&kind=option`, opts.signal),
      getJson(`${base}/api/v2/public/get_index_price?index_name=${asset.toLowerCase()}_usd`, opts.signal),
    ]);
    const underlying = Number(index?.index_price);
    if (!Array.isArray(summary) || !(underlying > 0)) {
      return { status: "unavailable", asset, asOf, reason: "Malformed Deribit response", source };
    }
    const rows = parseBookSummary(summary, asOf);
    if (!rows.length) return { status: "unavailable", asset, asOf, reason: "Empty option chain", source };
    const chain: OptionChain = {
      status: "ok",
      asset,
      asOf,
      underlying,
      rows,
      source,
      provenance: "observed",
      mode: "live",
      licensing: DERIBIT_LICENSING,
    };
    return chain;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const reason = /abort/i.test(msg)
      ? "Request aborted"
      : /fetch|network|cors/i.test(msg)
        ? `Deribit unreachable from this browser (${msg}) — network, CORS or geo restriction`
        : `Deribit error: ${msg}`;
    return { status: "unavailable", asset, asOf, reason, source };
  }
}

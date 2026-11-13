import { parseCboeVix, parseFredVix } from "@/lib/engine/eventstudy";

export const runtime = "nodejs";

/**
 * CBOE VIX daily OHLC. Primary: CBOE's public history CSV (no key). Fallback: FRED
 * VIXCLS (close only, needs FRED_API_KEY). Fetched server-side; cached for an hour.
 */
export async function GET() {
  const errors: string[] = [];
  try {
    const r = await fetch("https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv", { next: { revalidate: 3600 } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const bars = parseCboeVix(await r.text());
    if (bars.length < 100) throw new Error("too few rows");
    return Response.json({ status: "ok", source: "CBOE VIX_History.csv (daily OHLC)", ohlc: true, bars: bars.slice(-2500), asOf: Date.now() });
  } catch (e) {
    errors.push(`CBOE: ${(e as Error).message}`);
  }
  const key = process.env.FRED_API_KEY;
  if (key) {
    try {
      const r = await fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=VIXCLS&api_key=${key}&file_type=json&sort_order=asc&observation_start=2017-01-01`, { next: { revalidate: 3600 } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const bars = parseFredVix(await r.json());
      return Response.json({ status: "ok", source: "FRED VIXCLS (daily close only)", ohlc: false, bars: bars.slice(-2500), asOf: Date.now(), errors });
    } catch (e) {
      errors.push(`FRED: ${(e as Error).message}`);
    }
  } else errors.push("FRED fallback disabled (no FRED_API_KEY)");
  return Response.json({ status: "unavailable", reason: errors.join("; "), asOf: Date.now() }, { status: 503 });
}

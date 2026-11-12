export const runtime = "nodejs";

/**
 * Macro series via FRED (St. Louis Fed). Server-side so the API key never reaches the browser.
 * Requires FRED_API_KEY; otherwise returns 501 and the UI shows "Unavailable".
 */
const SERIES: Record<string, { name: string; units: string; channel: string }> = {
  DGS10: { name: "US 10Y Treasury yield", units: "%", channel: "Discount rate / opportunity cost of holding non-yielding assets" },
  DFII10: { name: "US 10Y real yield (TIPS)", units: "%", channel: "Real-rate pressure on duration & risk assets" },
  DTWEXBGS: { name: "Broad USD index", units: "index", channel: "Dollar liquidity; inverse correlation with BTC in risk-off" },
  NASDAQCOM: { name: "Nasdaq Composite", units: "index", channel: "Risk-appetite co-movement" },
  BAMLH0A0HYM2: { name: "US HY credit spread", units: "%", channel: "Credit stress / deleveraging" },
  T10YIE: { name: "10Y breakeven inflation", units: "%", channel: "Inflation expectations / Fed path" },
};

export async function GET() {
  const key = process.env.FRED_API_KEY;
  if (!key) return Response.json({ error: "FRED_API_KEY not configured on the server" }, { status: 501 });
  const out = await Promise.all(
    Object.entries(SERIES).map(async ([id, meta]) => {
      try {
        const r = await fetch(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${key}&file_type=json&sort_order=desc&limit=30`, { next: { revalidate: 3600 } });
        if (!r.ok) return { id, ...meta, error: `HTTP ${r.status}` };
        const j = (await r.json()) as { observations: { date: string; value: string }[] };
        const obs = j.observations.filter((o) => o.value !== ".").map((o) => ({ date: o.date, value: Number(o.value) }));
        return { id, ...meta, source: "FRED", observations: obs.reverse() };
      } catch (e) {
        return { id, ...meta, error: (e as Error).message };
      }
    }),
  );
  return Response.json({ asOf: new Date().toISOString(), series: out });
}

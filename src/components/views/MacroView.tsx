"use client";

import { useEffect, useState } from "react";
import { Spark } from "../charts/Spark";
import { Card, fmt, ProvTag, Unavailable } from "../ui";

interface Series { id: string; name: string; units: string; channel: string; source?: string; observations?: { date: string; value: number }[]; error?: string }
type Stable = { status: "ok"; points: { t: number; usd: number }[] } | { status: "unavailable"; reason: string } | null;

export function MacroView() {
  const [macro, setMacro] = useState<{ series?: Series[]; error?: string; asOf?: string } | null>(null);
  const [stable, setStable] = useState<Stable>(null);

  useEffect(() => {
    fetch("/api/macro").then(async (r) => setMacro(await r.json())).catch((e) => setMacro({ error: (e as Error).message }));
    fetch("https://stablecoins.llama.fi/stablecoincharts/all")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { date: string; totalCirculatingUSD?: { peggedUSD?: number } }[];
        const pts = j.slice(-120).map((x) => ({ t: Number(x.date) * 1000, usd: x.totalCirculatingUSD?.peggedUSD ?? 0 })).filter((x) => x.usd > 0);
        setStable(pts.length ? { status: "ok", points: pts } : { status: "unavailable", reason: "empty response" });
      })
      .catch((e) => setStable({ status: "unavailable", reason: `DefiLlama unreachable (${(e as Error).message})` }));
  }, []);

  const s = stable?.status === "ok" ? stable.points : null;
  const chg = (d: number) => (s && s.length > d ? s[s.length - 1].usd - s[s.length - 1 - d].usd : null);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {macro?.series ? macro.series.map((x) => {
          const o = x.observations ?? [];
          const last = o.at(-1), prev = o.at(-2);
          return (
            <Card key={x.id} title={x.name} subtitle={`${x.id} · FRED · ${last?.date ?? "—"}`} right={<ProvTag p="observed" />}>
              {x.error ? <Unavailable reason={x.error} /> : (
                <>
                  <div className="flex items-baseline gap-2 tnum"><span className="text-lg font-semibold">{last?.value.toFixed(2)}{x.units === "%" ? "%" : ""}</span><span className="text-[11px] text-dim">{last && prev ? `${last.value - prev.value >= 0 ? "+" : ""}${(last.value - prev.value).toFixed(2)} d/d` : ""}</span></div>
                  <Spark height={50} series={[{ values: o.map((p) => p.value), color: "#6AA3D9" }]} />
                  <p className="mt-1 text-[10px] text-mute">Transmission: {x.channel}</p>
                </>
              )}
            </Card>
          );
        }) : (
          <Card title="Rates, dollar, equities & credit" className="md:col-span-2 xl:col-span-3">
            <Unavailable reason={macro?.error ?? "loading…"} />
            <p className="mt-2 text-[11px] text-mute">Set <code className="text-dim">FRED_API_KEY</code> on the server to enable US yields, real yields, broad dollar, Nasdaq, HY spreads and breakevens.</p>
          </Card>
        )}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Card title="Stablecoin supply (USD-pegged)" subtitle="DefiLlama · daily · issuance/redemption proxy for on-ramp liquidity" right={<ProvTag p="observed" />}>
          {s ? (
            <>
              <div className="flex gap-4 tnum text-[12px]"><span className="text-lg font-semibold">{fmt.usd(s.at(-1)!.usd)}</span><span className={(chg(7) ?? 0) >= 0 ? "text-bull" : "text-bear"}>{fmt.usd(chg(7))} 7d</span><span className={(chg(30) ?? 0) >= 0 ? "text-bull" : "text-bear"}>{fmt.usd(chg(30))} 30d</span></div>
              <Spark height={70} series={[{ values: s.map((p) => p.usd), color: "#31B996" }]} />
            </>
          ) : <Unavailable reason={stable?.status === "unavailable" ? stable.reason : "loading…"} />}
        </Card>
        <Card title="Economic calendar · Fed expectations">
          <Unavailable reason="no licensed calendar / rates-futures feed connected" />
          <p className="mt-2 text-[11px] text-mute">Each event must carry timestamp, source, consensus / actual / surprise and transmission channel. ATLAS will not fabricate a schedule; connect a provider (e.g. a licensed economic-calendar API) via the macro adapter.</p>
        </Card>
        <Card title="US spot BTC ETF flows & holdings">
          <Unavailable reason="requires a licensed issuer-data feed (daily creations/redemptions)" />
        </Card>
        <Card title="Corporate treasuries · geopolitical & exchange-incident headlines">
          <Unavailable reason="requires a licensed news / filings feed" />
        </Card>
      </div>
    </div>
  );
}

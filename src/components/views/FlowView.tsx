"use client";

import { useAtlas } from "@/lib/state/store";
import { LIQ_MODEL_ASSUMPTIONS, LEVERAGE_SCENARIOS } from "@/lib/engine/liqmodel";
import { Spark } from "../charts/Spark";
import { LiqMapChart } from "../charts/LiqMapChart";
import { Badge, Card, cn, fmt, ProvTag, Unavailable } from "../ui";
import { FeatureTable } from "../widgets";
import { Loading } from "./CommandView";

export function FlowView() {
  const snap = useAtlas((s) => s.snap);
  if (!snap) return <Loading />;
  const flow = snap.flow;
  const perps = snap.venues.filter((v) => v.market === "perp");
  const lt = snap.liqTotals;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-3">
        <Card title="Session CVD — spot vs perp" subtitle={`All venues · base units · since ${fmt.time(snap.sessionStart)}`} right={<ProvTag p="observed" />} className="lg:col-span-2">
          <Spark height={150} zero series={[{ values: flow.map((f) => f.spotCvd), color: "#6AA3D9" }, { values: flow.map((f) => f.perpCvd), color: "#D9AA65" }]} />
          <Spark height={60} series={[{ values: flow.map((f) => f.price), color: "#F2F5F7" }]} />
          <div className="mt-1 flex gap-3 text-[10px]"><span className="text-info">■ spot CVD {fmt.num(flow.at(-1)?.spotCvd ?? null, 1)}</span><span className="text-warn">■ perp CVD {fmt.num(flow.at(-1)?.perpCvd ?? null, 1)}</span><span className="text-fg">■ price</span></div>
          <p className="mt-1 text-[10px] text-mute">Rising price with perp CVD up and spot CVD flat/down = futures-led (fragile). Spot CVD leading = spot demand.</p>
        </Card>
        <Card title="CVD by venue (USD)" right={<ProvTag p="observed" />}>
          <ul className="space-y-1 text-[11px]">
            {snap.venueCvd.slice(0, 10).map((v) => {
              const max = Math.max(1, ...snap.venueCvd.map((x) => Math.abs(x.usd)));
              return (
                <li key={v.key} className="flex items-center gap-2">
                  <span className="w-28 truncate text-dim">{v.key}</span>
                  <span className="flex-1 h-1.5 bg-elev rounded relative overflow-hidden"><span className={cn("absolute top-0 h-full", v.usd >= 0 ? "bg-bull left-1/2" : "bg-bear right-1/2")} style={{ width: `${(Math.abs(v.usd) / max) * 50}%` }} /></span>
                  <span className={cn("w-16 text-right tnum", v.usd >= 0 ? "text-bull" : "text-bear")}>{fmt.usd(v.usd)}</span>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>

      <Card title="Derivatives positioning by venue" subtitle="OI normalized to USD · funding normalized to 8h · mark/index dislocation" right={<ProvTag p="observed" />} bodyClass="p-0 overflow-x-auto">
        <table className="w-full min-w-[640px] text-[11px] tnum">
          <thead><tr className="text-left text-mute border-b border-line/60">{["Venue", "OI (USD)", "Funding /8h", "Annualized", "Mark", "Index", "Mark–Index", "State"].map((h) => <th key={h} className="px-2 py-1.5 font-normal">{h}</th>)}</tr></thead>
          <tbody>
            {perps.map((v) => (
              <tr key={v.key} className="border-b border-line/30">
                <td className="px-2 py-1">{v.venue}</td>
                <td className="px-2">{fmt.usd(v.oiUsd)}</td>
                <td className={cn("px-2", (v.funding8h ?? 0) >= 0 ? "text-bull" : "text-bear")}>{v.funding8h !== null ? `${(v.funding8h * 1e4).toFixed(2)}bp` : "—"}</td>
                <td className="px-2 text-dim">{v.funding8h !== null ? fmt.pct(v.funding8h * 3 * 365, 1) : "—"}</td>
                <td className="px-2">{fmt.px(v.mark)}</td>
                <td className="px-2">{fmt.px(v.index)}</td>
                <td className={cn("px-2", Math.abs(v.markIndexBps ?? 0) > 5 ? "text-warn" : "text-dim")}>{fmt.bps(v.markIndexBps)}</td>
                <td className="px-2"><Badge tone={v.state === "live" ? "bull" : "warn"}>{v.state}</Badge></td>
              </tr>
            ))}
            <tr className="border-t border-line"><td className="px-2 py-1 text-dim">Total / avg</td><td className="px-2 font-semibold">{fmt.usd(snap.oiTotalUsd)}</td><td className="px-2">{snap.fundingAvg8h !== null ? `${(snap.fundingAvg8h * 1e4).toFixed(2)}bp` : "—"}</td><td colSpan={5} /></tr>
          </tbody>
        </table>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="Liquidations — reported by venues" subtitle="Actual events · lower bound (venue feeds are sampled/throttled)" right={<ProvTag p="observed" />}>
          <div className="grid grid-cols-4 gap-2 text-[11px] tnum mb-2">
            <Stat k="Longs 5m" v={fmt.usd(lt.long5m)} c="text-bear" /><Stat k="Shorts 5m" v={fmt.usd(lt.short5m)} c="text-bull" />
            <Stat k="Longs 1h" v={fmt.usd(lt.long1h)} c="text-bear" /><Stat k="Shorts 1h" v={fmt.usd(lt.short1h)} c="text-bull" />
          </div>
          <div className="max-h-56 overflow-y-auto">
            {snap.liquidations.length ? (
              <table className="w-full text-[11px] tnum">
                <tbody>{snap.liquidations.slice(0, 40).map((l, i) => <tr key={i} className="border-t border-line/30"><td className="text-mute py-0.5">{fmt.time(l.ts)}</td><td className="text-dim">{l.venue}</td><td className={l.side === "long" ? "text-bear" : "text-bull"}>{l.side} liq</td><td>{fmt.px(l.price)}</td><td className="text-right">{fmt.usd(l.usd)}</td></tr>)}</tbody>
              </table>
            ) : <p className="text-[11px] text-mute">No liquidations reported this session.</p>}
          </div>
        </Card>
        <Card title="Modeled liquidation map" subtitle={snap.liqMap ? `±6% · ${snap.liqMap.barsUsed} × 5m bars · whiskers = low/high leverage scenarios` : ""} right={<ProvTag p="modeled" />}>
          {snap.liqMap ? (
            <>
              <LiqMapChart map={snap.liqMap} height={240} />
              <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] tnum">
                <Stat k="Est. long exposure (below)" v={fmt.usd(snap.liqMap.totalLongUsd)} c="text-bear" />
                <Stat k="Est. short exposure (above)" v={fmt.usd(snap.liqMap.totalShortUsd)} c="text-bull" />
              </div>
              <details className="mt-2 text-[10px] text-mute">
                <summary className="cursor-pointer text-dim">Assumptions & leverage scenarios</summary>
                <ul className="mt-1 list-disc pl-4 space-y-0.5">{LIQ_MODEL_ASSUMPTIONS.map((a, i) => <li key={i}>{a}</li>)}</ul>
                <div className="mt-1">{Object.entries(LEVERAGE_SCENARIOS).map(([k, v]) => <div key={k}>{k}: {v.map(([l, w]) => `${l}x·${Math.round(w * 100)}%`).join(" ")}</div>)}</div>
                <p className="mt-1">Exact liquidation levels are not publicly observable. This is an estimate, not data.</p>
              </details>
            </>
          ) : <Unavailable reason="requires ≥20 bars with open interest" />}
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="Large executions" subtitle="≥ max(floor, rolling p99.5 trade size) · size does not imply identity" right={<ProvTag p="observed" />}>
          <div className="max-h-64 overflow-y-auto">
            {snap.largeTrades.length ? (
              <table className="w-full text-[11px] tnum">
                <tbody>{snap.largeTrades.map((t, i) => <tr key={i} className="border-t border-line/30"><td className="text-mute py-0.5">{fmt.time(t.ts)}</td><td className="text-dim">{t.venue} {t.market}</td><td className={t.side === "buy" ? "text-bull" : "text-bear"}>{t.side}</td><td>{fmt.px(t.price)}</td><td className="text-right">{fmt.usd(t.usd)}</td></tr>)}</tbody>
              </table>
            ) : <p className="text-[11px] text-mute">None yet.</p>}
          </div>
        </Card>
        <Card title="Feature panel (1h)" subtitle="Robust z vs trailing 500 bars · hover rows for formula & weight">
          <FeatureTable a={snap.assessments["1h"]} />
        </Card>
      </div>

      <Card title="On-chain, miner & labeled-wallet flows">
        <Unavailable reason="requires a licensed on-chain data provider (exchange reserves, miner outflows, labeled wallets). Adapter interface reserved — values are never inferred from price data." />
      </Card>
    </div>
  );
}

function Stat({ k, v, c }: { k: string; v: string; c?: string }) {
  return <div><div className="text-[10px] text-mute">{k}</div><div className={c}>{v}</div></div>;
}

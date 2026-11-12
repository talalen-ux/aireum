"use client";

import { useAtlas } from "@/lib/state/store";
import type { useEngine } from "@/lib/state/useEngine";
import { VENUE_CATALOG } from "@/lib/adapters";
import { FEATURES } from "@/lib/engine/features";
import { Badge, Card, fmt, ProvTag } from "../ui";
import { FeatureTable } from "../widgets";
import { Loading } from "./CommandView";

export function SystemView({ engine: _engine }: { engine: ReturnType<typeof useEngine> }) {
  const snap = useAtlas((s) => s.snap);
  if (!snap) return <Loading />;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-4">
        <Card title="Mode"><Badge tone={snap.mode === "live" ? "bull" : "warn"}>{snap.mode.toUpperCase()}</Badge><p className="mt-1 text-[10px] text-mute">Simulation and replay are separated from live in every view and every journal entry.</p></Card>
        <Card title="Throughput"><div className="text-lg tnum">{snap.eventsPerSec.toFixed(0)} ev/s</div><p className="text-[10px] text-mute">normalized events into the worker</p></Card>
        <Card title="History bootstrap"><div className="text-[11px]">{snap.history.source}</div><div className="text-[10px] text-mute">{snap.history.flowAvailable ? "aggressor-side flow available" : "no historical flow split"}</div>{snap.history.errors.map((e, i) => <div key={i} className="text-[10px] text-warn">{e}</div>)}</Card>
        <Card title="Session"><div className="text-[11px] tnum">since {fmt.time(snap.sessionStart)}</div><div className="text-[10px] text-mute">recording: {snap.recording ? `${snap.recordedEvents.toLocaleString()} events` : "off"}</div></Card>
      </div>

      <Card title="Venue coverage & integrity" bodyClass="p-0 overflow-x-auto">
        <table className="w-full min-w-[900px] text-[11px]">
          <thead><tr className="text-left text-mute border-b border-line/60">{["Venue", "Markets", "Book method", "Integrity check", "Liqs", "OI", "Funding", "Caveats"].map((h) => <th key={h} className="px-2 py-1.5 font-normal">{h}</th>)}</tr></thead>
          <tbody>
            {VENUE_CATALOG.map((v) => (
              <tr key={v.venue} className="border-b border-line/30 align-top">
                <td className="px-2 py-1 font-medium">{v.name}</td>
                <td className="px-2 text-dim">{v.markets.join(", ")}</td>
                <td className="px-2 text-dim">{v.book}</td>
                <td className="px-2 text-dim">{v.integrity}</td>
                <td className="px-2">{v.observedLiquidations ? "✓" : "—"}</td>
                <td className="px-2">{v.openInterest ? "✓" : "—"}</td>
                <td className="px-2">{v.funding ? "✓" : "—"}</td>
                <td className="px-2 text-mute max-w-md">{v.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Feed health (live)" bodyClass="p-0 overflow-x-auto">
        <table className="w-full min-w-[720px] text-[11px] tnum">
          <thead><tr className="text-left text-mute border-b border-line/60">{["Stream", "State", "Detail", "Latency (median exch→recv)", "Last msg", "Gaps", "Quality flags"].map((h) => <th key={h} className="px-2 py-1.5 font-normal">{h}</th>)}</tr></thead>
          <tbody>{snap.venues.map((v) => <tr key={v.key} className="border-b border-line/30"><td className="px-2 py-1">{v.key}</td><td className="px-2"><Badge tone={v.state === "live" ? "bull" : v.state === "unavailable" || v.state === "disconnected" ? "bear" : "warn"}>{v.state}</Badge></td><td className="px-2 text-mute max-w-xs truncate" title={v.detail}>{v.detail}</td><td className="px-2">{fmt.age(v.latencyMs)}</td><td className="px-2">{fmt.age(v.ageMs)}</td><td className="px-2">{v.gaps}</td><td className="px-2 text-mute">{v.flags.join(", ") || "ok"}</td></tr>)}</tbody>
        </table>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="Feature registry (Market Regime Engine)" subtitle="Defined mathematically · robust z vs trailing 500 bars · point-in-time">
          <ul className="space-y-1.5 text-[11px]">
            {FEATURES.map((f) => (
              <li key={f.id} className="border-b border-line/30 pb-1">
                <div className="flex items-center gap-2"><span className="font-medium">{f.name}</span><ProvTag p={f.provenance} /><span className="ml-auto text-[10px] text-mute">w {f.weight} · {f.reliability}</span></div>
                <div className="font-mono text-[10px] text-dim">{f.formula}</div>
                <div className="text-[10px] text-mute">window {f.window} · {f.normalization} · sources: {f.sources.join(", ")}</div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Current feature values (15m)"><FeatureTable a={snap.assessments["15m"]} /></Card>
      </div>
    </div>
  );
}

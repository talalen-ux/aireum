"use client";

import { useState } from "react";
import { useAtlas } from "@/lib/state/store";
import { DETECTOR_LABEL } from "@/lib/engine/detectors";
import { Badge, Card, cn, fmt, ProvTag, Tabs } from "../ui";
import { ExhaustionPanel, OpportunityCard } from "../widgets";
import { Loading } from "./CommandView";

export function RadarView() {
  const snap = useAtlas((s) => s.snap);
  const [filter, setFilter] = useState<"all" | "long" | "short">("all");
  if (!snap) return <Loading />;
  const opps = snap.opportunities.filter((o) => filter === "all" || o.side === filter);
  const an = snap.analogs;
  return (
    <div className="grid gap-3 xl:grid-cols-[1fr_360px]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[13px] font-semibold">Opportunity Radar</h2>
          <Badge>{snap.opportunities.length} live</Badge>
          <Tabs value={filter} onChange={setFilter} items={[{ id: "all", label: "Both sides" }, { id: "long", label: "Long" }, { id: "short", label: "Short" }]} />
          <span className="text-[10px] text-mute">Long and short hypotheses are evaluated symmetrically. Strength = evidence agreement, never a probability.</span>
        </div>
        {opps.length ? opps.map((o) => <OpportunityCard key={o.key} o={o} price={snap.price} compact />) : <div className="rounded-lg border border-dashed border-line p-6 text-center text-[12px] text-mute">No detector currently meets its evidence threshold. That is information too.</div>}

        <Card title="Recently invalidated / expired" subtitle="Kept for accountability">
          {snap.recentOpportunities.length ? (
            <table className="w-full text-[11px] tnum">
              <tbody>
                {snap.recentOpportunities.map((o, i) => (
                  <tr key={i} className="border-t border-line/30">
                    <td className="py-0.5 text-mute">{fmt.time(o.updated)}</td>
                    <td>{DETECTOR_LABEL[o.detector]}</td>
                    <td className={o.side === "long" ? "text-bull" : "text-bear"}>{o.side}</td>
                    <td>{o.tf}</td>
                    <td><Badge tone={o.state === "invalidated" ? "bear" : "dim"}>{o.state}</Badge></td>
                    <td className="text-right text-dim">from {fmt.px(o.firstPrice)} → {fmt.px(snap.price)} ({o.firstPrice ? fmt.pct((snap.price ?? o.firstPrice) / o.firstPrice - 1) : "—"})</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="text-[11px] text-mute">None yet.</p>}
        </Card>
      </div>
      <div className="space-y-3">
        <Card title="Exhaustion engine" subtitle={`${snap.exhaustion.tf} bars`} right={<ProvTag p="modeled" />}>
          <div className="space-y-2">
            <ExhaustionPanel sig={snap.exhaustion.long} label="Downside exhaustion → long" />
            <ExhaustionPanel sig={snap.exhaustion.short} label="Upside exhaustion → short" />
          </div>
        </Card>
        <Card title="Historical analogs (5m, in-sample)" subtitle="Bar-only replay of the exhaustion detector; no book input; before costs">
          {(["exh:long", "exh:short"] as const).map((k) => {
            const a = an[k];
            return (
              <div key={k} className="mb-2 text-[11px]">
                <div className={k.endsWith("long") ? "text-bull" : "text-bear"}>{k.endsWith("long") ? "Downside exhaustion → long" : "Upside exhaustion → short"}</div>
                {a ? (
                  <div className="grid grid-cols-4 gap-1 tnum">
                    <div><div className="text-[9px] text-mute">n</div>{a.n}</div>
                    <div><div className="text-[9px] text-mute">median {a.horizonBars} bars</div>{fmt.bps(a.medianFwdBps)}</div>
                    <div><div className="text-[9px] text-mute">hit rate</div>{a.hitRate !== null ? `${Math.round(a.hitRate * 100)}%` : "—"}</div>
                    <div><div className="text-[9px] text-mute">median MAE</div>{fmt.bps(a.medianMaeBps)}</div>
                  </div>
                ) : <span className="text-mute">computing…</span>}
              </div>
            );
          })}
          <p className="text-[10px] text-mute">Small n, overlapping regimes and in-sample selection make these descriptive only. Out-of-sample walk-forward validation lives in /research.</p>
        </Card>
        <Card title="Detector coverage">
          <ul className="space-y-0.5 text-[11px]">
            {snap.detectors.map((d) => (
              <li key={d.id} className="flex items-center gap-2" title={d.reason}>
                <span className={cn("h-1.5 w-1.5 rounded-full", d.available ? "bg-bull" : "bg-mute")} />
                <span className={d.available ? "text-dim" : "text-mute"}>{DETECTOR_LABEL[d.id]}</span>
                {!d.available && d.reason && <span className="ml-auto text-[9px] text-mute truncate max-w-[45%]">{d.reason}</span>}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Signal audit trail" subtitle="Every lifecycle transition with evidence digest (FNV-1a)">
          <div className="max-h-64 overflow-y-auto">
            <table className="w-full text-[10px] tnum">
              <tbody>{snap.audit.map((a, i) => <tr key={i} className="border-t border-line/30"><td className="text-mute py-0.5">{fmt.time(a.ts)}</td><td className="text-dim truncate max-w-[120px]">{a.key}</td><td>{a.from ?? "∅"}→{a.to}</td><td className="text-mute">{a.digest}</td></tr>)}</tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

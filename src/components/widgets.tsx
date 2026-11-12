"use client";

import { useState } from "react";
import type { Evidence, Timeframe } from "@/lib/core/types";
import type { TfAssessment } from "@/lib/engine/regime";
import { REGIME_LABEL } from "@/lib/engine/regime";
import type { Opportunity } from "@/lib/engine/detectors";
import { DETECTOR_LABEL } from "@/lib/engine/detectors";
import type { ExhaustionSignal } from "@/lib/engine/exhaustion";
import { FEATURES } from "@/lib/engine/features";
import { Badge, Card, cn, EvidenceList, Expandable, fmt, Meter, ProvTag } from "./ui";

export function pressureLabel(v: number | null) {
  if (v === null) return "—";
  const a = Math.abs(v);
  const s = a < 0.15 ? "Neutral" : a < 0.4 ? "Mild" : a < 0.7 ? "Strong" : "Extreme";
  return a < 0.15 ? s : `${s} ${v > 0 ? "buy" : "sell"}`;
}

export function RegimeStrip({ assess, compact = false }: { assess: Partial<Record<Timeframe, TfAssessment>>; compact?: boolean }) {
  const tfs: Timeframe[] = ["5m", "15m", "1h", "4h", "1d", "1w"];
  return (
    <div className={cn("grid gap-2", compact ? "grid-cols-3 sm:grid-cols-6" : "grid-cols-2 sm:grid-cols-3 xl:grid-cols-6")}>
      {tfs.map((tf) => {
        const a = assess[tf];
        const active = a?.regimes.filter((r) => (r.score ?? 0) >= 0.5).sort((x, y) => (y.score ?? 0) - (x.score ?? 0)) ?? [];
        const dp = a?.directionalPressure ?? null;
        return (
          <div key={tf} className="rounded-lg border border-line/70 bg-card p-2.5 min-w-0">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold text-dim">{tf}</span>
              {a?.warmingUp ? <Badge>warming</Badge> : a?.leadership ? <Badge tone={a.leadership === "spot" ? "info" : a.leadership === "perp" ? "warn" : "dim"}>{a.leadership}-led</Badge> : null}
            </div>
            <div className="mt-1 text-[13px] font-semibold truncate" title={active.map((r) => REGIME_LABEL[r.id]).join(", ")}>
              {active[0] ? REGIME_LABEL[active[0].id] : a ? "No dominant regime" : "—"}
            </div>
            <div className="text-[10px] text-mute truncate h-3.5">{active.slice(1, 3).map((r) => REGIME_LABEL[r.id]).join(" · ")}</div>
            <div className="mt-1.5">
              <Meter value={dp} diverging />
              <div className="mt-0.5 flex justify-between text-[10px]">
                <span className={cn("tnum", dp === null ? "text-mute" : dp > 0.15 ? "text-bull" : dp < -0.15 ? "text-bear" : "text-dim")}>{pressureLabel(dp)}</span>
                <span className="text-mute tnum">conf {a ? Math.round(a.dataConfidence * 100) : "—"}%</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ScoreTile({ title, value, display, tone, diverging, evidence, note }: { title: string; value: number | null; display: string; tone?: "bull" | "bear" | "warn" | "info"; diverging?: boolean; evidence: Evidence[]; note?: string }) {
  return (
    <div className="rounded-lg border border-line/70 bg-card p-1.5">
      <Expandable
        head={
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-dim">{title}</span>
              <span className="text-[9px] text-mute">evidence ▾</span>
            </div>
            <div className="mt-0.5 text-[15px] font-semibold tnum">{display}</div>
            <div className="mt-1"><Meter value={value} diverging={diverging} tone={tone} /></div>
          </div>
        }
      >
        <EvidenceList items={evidence} />
        {note && <p className="mt-1.5 text-[10px] text-mute">{note}</p>}
      </Expandable>
    </div>
  );
}

const STATE_TONE = { detected: "dim", developing: "warn", actionable: "bull", invalidated: "bear", expired: "dim" } as const;
const STATE_LABEL = { detected: "Detected", developing: "Developing", actionable: "Actionable under assumptions", invalidated: "Invalidated", expired: "Expired" } as const;

export function OpportunityCard({ o, price, compact = false, onSelect, selected }: { o: Opportunity; price: number | null; compact?: boolean; onSelect?: () => void; selected?: boolean }) {
  const [open, setOpen] = useState(!compact);
  const dist = (p: number | null) => (p !== null && price ? `${(((p - price) / price) * 100).toFixed(2)}%` : "");
  return (
    <div className={cn("rounded-lg border bg-card p-3 min-w-0", selected ? "border-info/60" : "border-line/70", o.side === "long" ? "shadow-[inset_3px_0_0_0_#31B996]" : "shadow-[inset_3px_0_0_0_#D66C78]")}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={o.side === "long" ? "bull" : "bear"}>{o.side.toUpperCase()} hypothesis</Badge>
        <span className="text-[12px] font-semibold">{DETECTOR_LABEL[o.detector]}</span>
        <Badge>{o.tf}</Badge>
        <Badge tone={STATE_TONE[o.state]}>{STATE_LABEL[o.state]}</Badge>
        <span className="ml-auto text-[10px] text-mute tnum">since {fmt.time(o.firstSeen)}</span>
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-dim">{o.thesis}</p>
      <div className="mt-2 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
        <Kv k="Evidence strength" v={<span className="tnum">{Math.round(o.strength * 100)}<span className="text-mute">/100</span></span>} hint="Weighted agreement of measured conditions. Not a probability." />
        <Kv k="Completeness" v={<span className="tnum">{Math.round(o.completeness * 100)}%</span>} hint="Share of required inputs that were available." />
        <Kv k="Zone" v={o.zone ? <span className="tnum">{fmt.px(o.zone[0])}–{fmt.px(o.zone[1])}</span> : "—"} />
        <Kv k="Trigger" v={o.trigger !== null ? <span className="tnum text-warn">{fmt.px(o.trigger)} <span className="text-mute">{dist(o.trigger)}</span></span> : "—"} />
        <Kv k="Invalidation" v={o.invalidation !== null ? <span className="tnum text-bear">{fmt.px(o.invalidation)} <span className="text-mute">{dist(o.invalidation)}</span></span> : "—"} />
        <Kv k="Targets" v={o.targets.length ? <span className="tnum">{o.targets.map((t) => fmt.px(t.price, 0)).join(" · ")}</span> : "—"} />
        {o.analogs && <Kv k={`Analogs (n=${o.analogs.n})`} v={o.analogs.n ? <span className="tnum">{fmt.bps(o.analogs.medianFwdBps)} med · {o.analogs.hitRate !== null ? Math.round(o.analogs.hitRate * 100) : "—"}% hit</span> : "none"} hint={o.analogs.note} />}
      </div>
      {compact && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-2 text-[10px] text-info cursor-pointer">{open ? "hide evidence" : "evidence · counter-evidence · assumptions"}</button>
      )}
      {open && (
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          <div>
            <h4 className="text-[10px] uppercase tracking-wider text-bull mb-1">Evidence</h4>
            <EvidenceList items={o.evidence} />
          </div>
          <div>
            <h4 className="text-[10px] uppercase tracking-wider text-bear mb-1">Strongest counter-evidence</h4>
            <EvidenceList items={o.counter} empty="None measured — absence of counter-evidence is not confirmation." />
            <h4 className="text-[10px] uppercase tracking-wider text-dim mt-2 mb-1">Assumptions</h4>
            <ul className="list-disc pl-4 text-[10px] text-mute space-y-0.5">{o.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
            {o.targets.length > 0 && (
              <ul className="mt-1 text-[10px] text-mute">{o.targets.map((t, i) => <li key={i} className="tnum">→ {fmt.px(t.price)}: {t.why}</li>)}</ul>
            )}
          </div>
        </div>
      )}
      {onSelect && <button type="button" onClick={onSelect} className="mt-2 ml-3 text-[10px] text-dim hover:text-fg cursor-pointer">show on chart →</button>}
    </div>
  );
}

function Kv({ k, v, hint }: { k: string; v: React.ReactNode; hint?: string }) {
  return (
    <div title={hint} className="min-w-0">
      <div className="text-[10px] text-mute truncate">{k}</div>
      <div className="truncate">{v}</div>
    </div>
  );
}

export function ExhaustionPanel({ sig, label }: { sig: ExhaustionSignal | null; label: string }) {
  if (!sig) return <div className="rounded border border-dashed border-line p-3 text-[11px] text-mute">{label}: insufficient bars for evaluation</div>;
  const long = sig.side === "long";
  return (
    <div className="rounded-lg border border-line/70 bg-elev/40 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold">{label}</span>
        <Badge tone={sig.state === "actionable" ? "bull" : sig.state === "developing" ? "warn" : sig.state === "invalidated" ? "bear" : "dim"}>{sig.state}</Badge>
      </div>
      <div className="mt-2 flex items-end gap-3">
        <div className="text-2xl font-semibold tnum">{Math.round(sig.strength * 100)}</div>
        <div className="flex-1 pb-1.5"><Meter value={sig.strength} tone={long ? "bull" : "bear"} /><div className="mt-0.5 text-[9px] text-mute">evidence strength · completeness {Math.round(sig.completeness * 100)}%</div></div>
      </div>
      <ul className="mt-2 space-y-1">
        {sig.conditions.map((c) => (
          <li key={c.id} className="flex items-center gap-2 text-[11px]" title={c.detail}>
            <span className={cn("w-6 shrink-0 text-[9px] font-semibold", c.met === null ? "text-mute" : c.met >= 0.6 ? "text-bull" : c.met >= 0.4 ? "text-warn" : "text-bear")}>{c.id}</span>
            <span className={cn("flex-1 truncate", c.met === null ? "text-mute line-through" : "text-dim")}>{c.label}</span>
            <span className="w-14"><Meter value={c.met} tone={c.met === null ? undefined : c.met >= 0.6 ? "bull" : c.met >= 0.4 ? "warn" : "bear"} /></span>
          </li>
        ))}
      </ul>
      <div className="mt-2 grid grid-cols-3 gap-1 text-[10px] tnum">
        <div><span className="text-mute">extreme</span><br />{fmt.px(sig.extreme)}</div>
        <div><span className="text-mute">trigger</span><br /><span className="text-warn">{fmt.px(sig.trigger)}</span></div>
        <div><span className="text-mute">invalid</span><br /><span className="text-bear">{fmt.px(sig.invalidation)}</span></div>
      </div>
      {sig.counter.length > 0 && <div className="mt-2 text-[10px] text-bear/90">⚠ {sig.counter.map((c) => c.label).join(" · ")}</div>}
    </div>
  );
}

export function FeatureTable({ a }: { a: TfAssessment | undefined }) {
  if (!a?.features) return <p className="text-[11px] text-mute">No features yet.</p>;
  return (
    <table className="w-full text-[11px]">
      <thead><tr className="text-mute text-left"><th className="font-normal">Feature</th><th className="font-normal text-right">Raw</th><th className="font-normal text-right">z</th><th className="font-normal text-right">Prov.</th></tr></thead>
      <tbody>
        {FEATURES.map((f) => {
          const raw = a.features!.raw[f.id as keyof typeof a.features.raw];
          const z = a.features!.z[f.id as keyof typeof a.features.z];
          return (
            <tr key={f.id} className="border-t border-line/40" title={`${f.formula} · window ${f.window} · weight ${f.weight} · reliability ${f.reliability}`}>
              <td className="py-0.5 text-dim">{f.name}</td>
              <td className="text-right tnum">{raw === null ? "—" : Math.abs(raw) < 0.01 ? raw.toExponential(1) : raw.toFixed(3)}</td>
              <td className={cn("text-right tnum", z === null ? "text-mute" : z > 1 ? "text-bull" : z < -1 ? "text-bear" : "")}>{fmt.z(z)}</td>
              <td className="text-right"><ProvTag p={f.provenance} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export { Card };

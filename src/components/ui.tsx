"use client";

import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { useState, type ReactNode } from "react";
import type { Evidence, Provenance } from "@/lib/core/types";

export function cn(...a: Parameters<typeof clsx>) {
  return twMerge(clsx(...a));
}

export function Card({ title, subtitle, right, children, className, bodyClass }: { title?: ReactNode; subtitle?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={cn("rounded-lg border border-line/70 bg-card flex flex-col min-w-0", className)}>
      {(title || right) && (
        <header className="flex items-center justify-between gap-2 border-b border-line/60 px-3 py-2">
          <div className="min-w-0">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-dim truncate">{title}</h3>
            {subtitle && <p className="text-[11px] text-mute truncate">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-1.5 shrink-0">{right}</div>
        </header>
      )}
      <div className={cn("p-3 min-h-0 flex-1", bodyClass)}>{children}</div>
    </section>
  );
}

const PROV_STYLE: Record<Provenance, string> = {
  observed: "text-info border-info/40 bg-info/10",
  modeled: "text-model border-model/40 bg-model/10",
  inferred: "text-infer border-infer/40 bg-infer/10",
};

/** Every value is tagged observed / modeled / inferred (product principle). */
export function ProvTag({ p, className }: { p: Provenance; className?: string }) {
  return (
    <span title={PROV_DESC[p]} className={cn("inline-flex items-center rounded border px-1 text-[9px] font-semibold uppercase tracking-wider leading-[14px]", PROV_STYLE[p], className)}>
      {p === "observed" ? "OBS" : p === "modeled" ? "MODEL" : "INFER"}
    </span>
  );
}
const PROV_DESC: Record<Provenance, string> = {
  observed: "Observed: directly reported by a venue feed.",
  modeled: "Modeled: computed estimate with stated assumptions and uncertainty.",
  inferred: "Inferred: interpretation of observed behavior; intent is never verified.",
};

export function Badge({ children, tone = "dim", className }: { children: ReactNode; tone?: "bull" | "bear" | "warn" | "dim" | "info" | "model"; className?: string }) {
  const t = {
    bull: "text-bull bg-bull/10 border-bull/30",
    bear: "text-bear bg-bear/10 border-bear/30",
    warn: "text-warn bg-warn/10 border-warn/30",
    dim: "text-dim bg-elev border-line",
    info: "text-info bg-info/10 border-info/30",
    model: "text-model bg-model/10 border-model/30",
  }[tone];
  return <span className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10px] font-medium", t, className)}>{children}</span>;
}

export function Unavailable({ reason }: { reason: string }) {
  return (
    <div className="flex items-center gap-2 rounded border border-dashed border-line px-2 py-1.5 text-[11px] text-mute">
      <span className="h-1.5 w-1.5 rounded-full bg-mute" />
      Unavailable — {reason}
    </div>
  );
}

/** Horizontal score meter in [0,1] or [-1,1] (diverging). */
export function Meter({ value, diverging = false, tone }: { value: number | null; diverging?: boolean; tone?: "bull" | "bear" | "warn" | "info" }) {
  if (value === null) return <div className="h-1.5 rounded bg-elev" />;
  if (diverging) {
    const v = Math.max(-1, Math.min(1, value));
    const w = Math.abs(v) * 50;
    return (
      <div className="relative h-1.5 rounded bg-elev overflow-hidden">
        <div className="absolute left-1/2 top-0 h-full w-px bg-line" />
        <div className={cn("absolute top-0 h-full", v >= 0 ? "bg-bull" : "bg-bear")} style={{ left: v >= 0 ? "50%" : `${50 - w}%`, width: `${w}%` }} />
      </div>
    );
  }
  const v = Math.max(0, Math.min(1, value));
  const c = tone ? { bull: "bg-bull", bear: "bg-bear", warn: "bg-warn", info: "bg-info" }[tone] : v > 0.66 ? "bg-bear" : v > 0.4 ? "bg-warn" : "bg-bull";
  return (
    <div className="h-1.5 rounded bg-elev overflow-hidden">
      <div className={cn("h-full", c)} style={{ width: `${v * 100}%` }} />
    </div>
  );
}

export function EvidenceList({ items, empty = "No evidence yet" }: { items: Evidence[]; empty?: string }) {
  if (!items.length) return <p className="text-[11px] text-mute">{empty}</p>;
  return (
    <ul className="space-y-1">
      {items.map((e, i) => (
        <li key={i} className="flex items-start gap-2 text-[11px]">
          <span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", e.stance > 0 ? "bg-bull" : e.stance < 0 ? "bg-bear" : "bg-mute")} />
          <span className="flex-1 text-dim">
            {e.label}: <span className="tnum text-fg">{e.value}</span>
          </span>
          <ProvTag p={e.provenance} />
        </li>
      ))}
    </ul>
  );
}

/** Progressive drill-down: a metric that expands into its underlying evidence. */
export function Expandable({ head, children, defaultOpen = false }: { head: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded border border-transparent hover:border-line/60">
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className="w-full text-left px-1 py-1 cursor-pointer">
        {head}
      </button>
      {open && <div className="px-2 pb-2 pt-1 border-t border-line/50">{children}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: ReactNode }[] }) {
  return (
    <div className="flex gap-0.5 rounded-md bg-bg p-0.5 border border-line/60">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={() => onChange(it.id)}
          className={cn("rounded px-2 py-0.5 text-[11px] font-medium transition-colors cursor-pointer", value === it.id ? "bg-elev text-fg" : "text-mute hover:text-dim")}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

export const fmt = {
  px(v: number | null | undefined, d?: number) {
    if (v === null || v === undefined || !Number.isFinite(v)) return "—";
    const dd = d ?? (v >= 1000 ? 1 : v >= 10 ? 2 : 4);
    return v.toLocaleString("en-US", { minimumFractionDigits: dd, maximumFractionDigits: dd });
  },
  usd(v: number | null | undefined) {
    if (v === null || v === undefined || !Number.isFinite(v)) return "—";
    const a = Math.abs(v);
    const s = v < 0 ? "-" : "";
    if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
    if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}K`;
    return `${s}$${a.toFixed(0)}`;
  },
  num(v: number | null | undefined, d = 2) {
    if (v === null || v === undefined || !Number.isFinite(v)) return "—";
    return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  },
  pct(v: number | null | undefined, d = 2) {
    if (v === null || v === undefined || !Number.isFinite(v)) return "—";
    return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`;
  },
  bps(v: number | null | undefined, d = 1) {
    if (v === null || v === undefined || !Number.isFinite(v)) return "—";
    return `${v >= 0 ? "+" : ""}${v.toFixed(d)}bp`;
  },
  z(v: number | null | undefined) {
    if (v === null || v === undefined || !Number.isFinite(v)) return "—";
    return `${v >= 0 ? "+" : ""}${v.toFixed(2)}σ`;
  },
  age(ms: number | null | undefined) {
    if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
    if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${Math.round(ms / 3_600_000)}h`;
  },
  time(ts: number | null | undefined) {
    if (!ts) return "—";
    return new Date(ts).toISOString().slice(11, 19) + "Z";
  },
};

"use client";

import { useEffect, useRef, useState } from "react";
import { Circle, Download, Upload } from "lucide-react";
import { useAtlas } from "@/lib/state/store";
import type { useEngine } from "@/lib/state/useEngine";
import type { AnyEvent, DataMode } from "@/lib/core/types";
import { Badge, cn, fmt, Tabs } from "../ui";

export function ModeBanner() {
  const mode = useAtlas((s) => s.mode);
  if (mode === "live") return null;
  return (
    <div className={cn("w-full text-center text-[10px] font-bold tracking-[0.2em] py-0.5", mode === "simulation" ? "bg-warn/90 text-bg" : "bg-info/90 text-bg")}>
      {mode === "simulation" ? "SIMULATION — SYNTHETIC DATA, NOT A REAL MARKET" : "REPLAY — RECORDED SESSION, NOT LIVE"}
    </div>
  );
}

export function TopBar({ engine }: { engine: ReturnType<typeof useEngine> }) {
  const snap = useAtlas((s) => s.snap);
  const asset = useAtlas((s) => s.asset);
  const mode = useAtlas((s) => s.mode);
  const setAsset = useAtlas((s) => s.setAsset);
  const setMode = useAtlas((s) => s.setMode);
  const error = useAtlas((s) => s.error);
  const [now, setNow] = useState(Date.now());
  const prev = useRef<number | null>(null);
  const [flash, setFlash] = useState<"" | "flash-up" | "flash-down">("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const p = snap?.price ?? null;
    if (p !== null && prev.current !== null && p !== prev.current) setFlash(p > prev.current ? "flash-up" : "flash-down");
    prev.current = p;
  }, [snap?.price]);

  const live = snap?.liveVenues ?? 0;
  const total = snap?.totalStreams ?? 0;
  const age = snap?.priceTs ? (mode === "replay" ? snap.ts - snap.priceTs : now - snap.priceTs) : null;
  const health = live === 0 ? "bear" : live / Math.max(1, total) < 0.5 ? "warn" : "bull";

  const onFile = async (f: File) => {
    const text = await f.text();
    const events: AnyEvent[] = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    engine.replay(events, 1);
  };

  return (
    <header className="sticky top-0 z-40 bg-bg/95 backdrop-blur border-b border-line/60">
      <ModeBanner />
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2">
        <div className="flex items-center gap-2">
          <Logo />
          <span className="font-bold tracking-[0.25em] text-[13px]">ATLAS</span>
        </div>
        <Tabs value={asset} onChange={(a) => setAsset(a)} items={[{ id: "BTC", label: "BTC" }, { id: "ETH", label: "ETH" }]} />
        <div className="flex items-baseline gap-2 min-w-0">
          <span className={cn("tnum text-xl font-semibold rounded px-1", flash)} key={snap?.price ?? 0}>{fmt.px(snap?.price ?? null, asset === "BTC" ? 1 : 2)}</span>
          <span className={cn("tnum text-[12px]", (snap?.change24h ?? 0) >= 0 ? "text-bull" : "text-bear")}>{fmt.pct(snap?.change24h ?? null)} 24h</span>
          <span className="hidden md:inline text-[10px] text-mute truncate" title={snap?.priceSource ?? ""}>
            {snap?.priceSource ?? "awaiting data"} · {fmt.time(snap?.ts)} {age !== null && <span className={age > 5000 ? "text-warn" : ""}>· age {fmt.age(age)}</span>}
          </span>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Tabs<DataMode>
            value={mode}
            onChange={(m) => (m === "replay" ? fileRef.current?.click() : setMode(m))}
            items={[{ id: "live", label: "Live" }, { id: "simulation", label: "Simulation" }, { id: "replay", label: "Replay…" }]}
          />
          <input ref={fileRef} type="file" accept=".ndjson,.jsonl,.json" className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
          <Badge tone={mode === "live" ? "bull" : mode === "simulation" ? "warn" : "info"}>
            <span className={cn("h-1.5 w-1.5 rounded-full pulse-dot", mode === "live" ? "bg-bull" : mode === "simulation" ? "bg-warn" : "bg-info")} />
            {mode.toUpperCase()}
          </Badge>
          <Badge tone={health} className="tnum" >
            feeds {live}/{total}
          </Badge>
          <span className="hidden sm:inline tnum text-[10px] text-mute">{(snap?.eventsPerSec ?? 0).toFixed(0)} ev/s</span>
          <RecordButton engine={engine} recording={!!snap?.recording} count={snap?.recordedEvents ?? 0} />
          <span className="hidden md:inline tnum text-[11px] text-dim">{new Date(now).toISOString().slice(11, 19)}Z</span>
        </div>
      </div>
      {error && <div className="px-3 pb-1 text-[10px] text-bear truncate">engine: {error}</div>}
    </header>
  );
}

function RecordButton({ engine, recording, count }: { engine: ReturnType<typeof useEngine>; recording: boolean; count: number }) {
  const save = () =>
    engine.exportRecording((nd, n) => {
      if (!n) return;
      const blob = new Blob([nd], { type: "application/x-ndjson" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `atlas-session-${new Date().toISOString().replace(/[:.]/g, "-")}.ndjson`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
  return (
    <div className="flex items-center gap-1">
      <button type="button" title={recording ? "Stop recording normalized events" : "Record normalized events for deterministic replay"} onClick={() => engine.record(!recording)} className={cn("flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] cursor-pointer", recording ? "border-bear/50 text-bear" : "border-line text-dim hover:text-fg")}>
        <Circle size={9} className={recording ? "fill-bear pulse-dot" : ""} /> {recording ? `REC ${count.toLocaleString()}` : "Rec"}
      </button>
      {count > 0 && (
        <button type="button" title="Download recording (NDJSON) — load it with Replay" onClick={save} className="rounded border border-line p-0.5 text-dim hover:text-fg cursor-pointer">
          <Download size={12} />
        </button>
      )}
    </div>
  );
}

function Logo() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
      <circle cx="12" cy="12" r="10" fill="none" stroke="#31B996" strokeWidth="1.5" />
      <ellipse cx="12" cy="12" rx="4.5" ry="10" fill="none" stroke="#31B996" strokeWidth="1" opacity="0.6" />
      <line x1="2" y1="12" x2="22" y2="12" stroke="#31B996" strokeWidth="1" opacity="0.6" />
      <circle cx="16.5" cy="7.5" r="1.8" fill="#D9AA65" />
    </svg>
  );
}

export { Upload };

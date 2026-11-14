"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useAtlas, type View } from "@/lib/state/store";
import { useEngine } from "@/lib/state/useEngine";
import { TopBar } from "./shell/TopBar";
import { CommandView } from "./views/CommandView";
import { LiquidityView } from "./views/LiquidityView";
import { FlowView } from "./views/FlowView";
import { RadarView } from "./views/RadarView";
import { TechnicalsView } from "./views/TechnicalsView";
import { HarvestView } from "./views/HarvestView";
import { AnalystView } from "./views/AnalystView";
import { MacroView } from "./views/MacroView";
import { JournalView } from "./views/JournalView";
import { SystemView } from "./views/SystemView";
import { cn } from "./ui";
import { Activity, BookOpen, Bot, Crosshair, Gauge, Globe2, HandCoins, Layers, Radar, Sigma, TrendingUpDown, Waves, type LucideIcon } from "lucide-react";

const OptionsPanel = dynamic(() => import("./options/OptionsPanel"), { ssr: false });
const TradeLab = dynamic(() => import("./trade-lab/TradeLab"), { ssr: false });

const NAV: { id: View; label: string; icon: LucideIcon; key: string }[] = [
  { id: "command", label: "Command", icon: Gauge, key: "1" },
  { id: "liquidity", label: "Liquidity", icon: Layers, key: "2" },
  { id: "flow", label: "Flow & Derivs", icon: Waves, key: "3" },
  { id: "radar", label: "Opportunity Radar", icon: Radar, key: "4" },
  { id: "technicals", label: "VIX 2B · Gann", icon: TrendingUpDown, key: "t" },
  { id: "options", label: "Options", icon: Sigma, key: "5" },
  { id: "tradelab", label: "Trade Lab", icon: Crosshair, key: "6" },
  { id: "harvest", label: "Profit Harvesting", icon: HandCoins, key: "h" },
  { id: "analyst", label: "Analyst", icon: Bot, key: "7" },
  { id: "macro", label: "Macro", icon: Globe2, key: "8" },
  { id: "journal", label: "Journal", icon: BookOpen, key: "9" },
  { id: "system", label: "System", icon: Activity, key: "0" },
];

export default function AtlasApp() {
  const engine = useEngine();
  const view = useAtlas((s) => s.view);
  const setView = useAtlas((s) => s.setView);
  const snap = useAtlas((s) => s.snap);
  const asset = useAtlas((s) => s.asset);
  const mode = useAtlas((s) => s.mode);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement || e.metaKey || e.ctrlKey) return;
      const n = NAV.find((x) => x.key === e.key);
      if (n) setView(n.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setView]);

  if (!mounted) return <div className="min-h-dvh bg-bg" />;

  return (
    <div className="min-h-dvh flex flex-col">
      <TopBar engine={engine} />
      <div className="flex flex-1 min-h-0">
        <nav className="hidden lg:flex w-48 shrink-0 flex-col gap-0.5 border-r border-line/60 p-2 sticky top-[57px] h-[calc(100dvh-57px)]">
          {NAV.map((n) => (
            <button key={n.id} type="button" onClick={() => setView(n.id)} className={cn("flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] font-medium cursor-pointer transition-colors", view === n.id ? "bg-elev text-fg" : "text-dim hover:bg-card hover:text-fg")}>
              <n.icon size={14} className={view === n.id ? "text-bull" : "text-mute"} />
              <span className="flex-1 text-left">{n.label}</span>
              <kbd className="text-[9px] text-mute">{n.key}</kbd>
            </button>
          ))}
          <div className="mt-auto rounded-md border border-line/60 p-2 text-[10px] leading-relaxed text-mute">
            Research tool, not advice. Strength scores are evidence agreement, not probabilities. No predictive edge is claimed until validated out of sample.
          </div>
        </nav>
        <main className="flex-1 min-w-0 p-2 sm:p-3 pb-20 lg:pb-3">
          {view === "command" && <CommandView />}
          {view === "liquidity" && <LiquidityView />}
          {view === "flow" && <FlowView />}
          {view === "radar" && <RadarView />}
          {view === "technicals" && <TechnicalsView />}
          {view === "harvest" && <HarvestView />}
          {view === "options" && <OptionsPanel asset={asset} spot={snap?.price ?? null} mode={mode} />}
          {view === "tradelab" && <TradeLab asset={asset} markPrice={snap?.price ?? null} atr={snap?.atr5m ?? null} returns={snap?.returns1m} mode={mode} />}
          {view === "analyst" && <AnalystView />}
          {view === "macro" && <MacroView />}
          {view === "journal" && <JournalView />}
          {view === "system" && <SystemView engine={engine} />}
        </main>
      </div>
      {/* mobile bottom nav */}
      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-30 border-t border-line bg-bg/95 backdrop-blur grid grid-cols-5">
        {NAV.filter((n) => ["command", "radar", "liquidity", "tradelab", "analyst"].includes(n.id)).map((n) => (
          <button key={n.id} type="button" onClick={() => setView(n.id)} className={cn("flex flex-col items-center gap-0.5 py-2 text-[10px] cursor-pointer", view === n.id ? "text-fg" : "text-mute")}>
            <n.icon size={16} className={view === n.id ? "text-bull" : ""} />
            {n.label.split(" ")[0]}
          </button>
        ))}
      </nav>
      <MobileMore />
    </div>
  );
}

function MobileMore() {
  const view = useAtlas((s) => s.view);
  const setView = useAtlas((s) => s.setView);
  return (
    <div className="lg:hidden fixed bottom-14 right-2 z-30">
      <select aria-label="More views" value={view} onChange={(e) => setView(e.target.value as View)} className="rounded-md border border-line bg-card px-2 py-1 text-[11px] text-dim">
        {NAV.map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
      </select>
    </div>
  );
}

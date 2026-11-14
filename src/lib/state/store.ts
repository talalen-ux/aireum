"use client";

import { create } from "zustand";
import type { Asset, DataMode, Timeframe } from "../core/types";
import type { EngineSnapshot, HeatColumn } from "../engine/engine";
import type { Bar } from "../engine/bars";
import type { DvolResult } from "../engine/dvol";
import type { VixResult } from "../engine/eventstudy";

export type View = "command" | "liquidity" | "flow" | "radar" | "technicals" | "harvest" | "options" | "tradelab" | "analyst" | "macro" | "journal" | "system";

interface State {
  asset: Asset;
  mode: DataMode;
  view: View;
  chartTf: Timeframe | "1m";
  snap: EngineSnapshot | null;
  chartBars: Partial<Record<Timeframe, Bar[]>>;
  bars1m: Bar[];
  heat: HeatColumn[];
  heatStep: number;
  dvol: DvolResult | null;
  vix: VixResult | null;
  error: string | null;
  lastSnapAt: number;
  setAsset(a: Asset): void;
  setMode(m: DataMode): void;
  setView(v: View): void;
  setChartTf(tf: Timeframe | "1m"): void;
  ingest(s: EngineSnapshot): void;
  reset(): void;
  setError(e: string | null): void;
}

export const useAtlas = create<State>((set, get) => ({
  asset: "BTC",
  mode: "live",
  view: "command",
  chartTf: "5m",
  snap: null,
  chartBars: {},
  bars1m: [],
  heat: [],
  heatStep: 0,
  dvol: null,
  vix: null,
  error: null,
  lastSnapAt: 0,
  setAsset: (asset) => set({ asset }),
  setMode: (mode) => set({ mode }),
  setView: (view) => set({ view }),
  setChartTf: (chartTf) => set({ chartTf }),
  setError: (error) => set({ error }),
  reset: () => set({ snap: null, chartBars: {}, bars1m: [], heat: [], heatStep: 0, dvol: null, vix: null, error: null }),
  ingest: (s) => {
    const st = get();
    let heat = st.heat;
    if (s.heat.step && s.heat.step !== st.heatStep) heat = [];
    if (s.heat.cols.length) heat = [...heat, ...s.heat.cols].slice(-900);
    set({
      snap: s,
      heat,
      heatStep: s.heat.step || st.heatStep,
      chartBars: Object.keys(s.chartBars).length ? s.chartBars : st.chartBars,
      bars1m: s.bars1m.length ? s.bars1m : st.bars1m,
      dvol: s.dvol ?? st.dvol,
      vix: s.vix ?? st.vix,
      lastSnapAt: Date.now(),
    });
  },
}));

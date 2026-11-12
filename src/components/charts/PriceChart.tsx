"use client";

import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, createChart, createSeriesMarkers, CrosshairMode, HistogramSeries, LineSeries, type IChartApi, type IPriceLine, type ISeriesApi, type ISeriesMarkersPluginApi, type Time, type UTCTimestamp } from "lightweight-charts";
import type { Bar } from "@/lib/engine/bars";
import type { Opportunity } from "@/lib/engine/detectors";
import type { WallInfo } from "@/lib/engine/micro";

const C = { bg: "#151D26", grid: "#1f2a36", text: "#94A3B2", bull: "#31B996", bear: "#D66C78", warn: "#D9AA65", model: "#A58BE0", info: "#6AA3D9" };

export interface ChartOverlay {
  opportunity?: Opportunity | null;
  walls?: WallInfo[];
  liqClusters?: { price: number; side: "long" | "short"; usd: number }[];
}

/**
 * Synchronized multi-pane chart: candles (pane 0), spot vs perp signed volume (pane 1),
 * open interest (pane 2). Observed liquidations as markers; opportunity zone/trigger/invalidation
 * as price lines; walls (observed) and modeled liq clusters drawn with distinct styles.
 */
export function PriceChart({ bars, overlay, height = 420 }: { bars: Bar[]; overlay?: ChartOverlay; height?: number }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const s = useRef<{ candle: ISeriesApi<"Candlestick">; spot: ISeriesApi<"Histogram">; perp: ISeriesApi<"Histogram">; oi: ISeriesApi<"Line">; markers: ISeriesMarkersPluginApi<Time> } | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const fitted = useRef(false);

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: C.bg }, textColor: C.text, fontFamily: "Inter, ui-sans-serif", fontSize: 10, panes: { separatorColor: "#243241", enableResize: true } },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#243241" },
      timeScale: { borderColor: "#243241", timeVisible: true, secondsVisible: false },
    });
    const candle = c.addSeries(CandlestickSeries, { upColor: C.bull, downColor: C.bear, borderVisible: false, wickUpColor: C.bull, wickDownColor: C.bear });
    const spot = c.addSeries(HistogramSeries, { priceFormat: { type: "volume" }, title: "spot Δ" }, 1);
    const perp = c.addSeries(LineSeries, { color: C.warn, lineWidth: 1, title: "perp Δ", priceFormat: { type: "volume" } } as never, 1) as unknown as ISeriesApi<"Histogram">;
    const oi = c.addSeries(LineSeries, { color: C.info, lineWidth: 1, title: "OI", priceFormat: { type: "volume" } }, 2);
    const panes = c.panes();
    panes[0]?.setStretchFactor(0.62);
    panes[1]?.setStretchFactor(0.22);
    panes[2]?.setStretchFactor(0.16);
    const markers = createSeriesMarkers(candle, []);
    chart.current = c;
    s.current = { candle, spot, perp, oi, markers };
    return () => { c.remove(); chart.current = null; s.current = null; fitted.current = false; };
  }, []);

  useEffect(() => {
    const x = s.current;
    if (!x || !bars.length) return;
    const t = (b: Bar) => (b.t / 1000) as UTCTimestamp;
    x.candle.setData(bars.map((b) => ({ time: t(b), open: b.o, high: b.h, low: b.l, close: b.c })));
    x.spot.setData(bars.map((b) => {
      const d = b.spotBuy !== null && b.spotSell !== null ? b.spotBuy - b.spotSell : 0;
      return { time: t(b), value: d, color: d >= 0 ? "rgba(49,185,150,0.7)" : "rgba(214,108,120,0.7)" };
    }));
    (x.perp as unknown as ISeriesApi<"Line">).setData(bars.map((b) => ({ time: t(b), value: b.perpBuy !== null && b.perpSell !== null ? b.perpBuy - b.perpSell : 0 })));
    x.oi.setData(bars.filter((b) => b.oi !== null).map((b) => ({ time: t(b), value: b.oi as number })));
    const mk = bars
      .filter((b) => b.liqLong + b.liqShort > 0)
      .map((b) => {
        const long = b.liqLong >= b.liqShort;
        return { time: t(b), position: long ? ("belowBar" as const) : ("aboveBar" as const), shape: "circle" as const, color: long ? C.bear : C.bull, size: 0.6, text: "" };
      })
      .slice(-80);
    x.markers.setMarkers(mk);
    if (!fitted.current) { chart.current?.timeScale().fitContent(); fitted.current = true; }
  }, [bars]);

  useEffect(() => {
    const x = s.current;
    if (!x) return;
    for (const l of lines.current) x.candle.removePriceLine(l);
    lines.current = [];
    const add = (price: number, color: string, title: string, style = 2) => lines.current.push(x.candle.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
    const o = overlay?.opportunity;
    if (o) {
      if (o.zone) { add(o.zone[0], o.side === "long" ? C.bull : C.bear, "zone", 3); add(o.zone[1], o.side === "long" ? C.bull : C.bear, "zone", 3); }
      if (o.trigger !== null) add(o.trigger, C.warn, "trigger", 0);
      if (o.invalidation !== null) add(o.invalidation, "#ff4d5e", "invalidation", 0);
    }
    for (const w of overlay?.walls?.slice(0, 4) ?? []) add(w.price, w.side === "bid" ? "rgba(49,185,150,0.45)" : "rgba(214,108,120,0.45)", `wall ${(w.usd / 1e6).toFixed(1)}M OBS`, 1);
    for (const c of overlay?.liqClusters?.slice(0, 2) ?? []) add(c.price, C.model, `liq ${c.side} ~${(c.usd / 1e6).toFixed(0)}M MODEL`, 1);
  }, [overlay?.opportunity, overlay?.walls, overlay?.liqClusters]);

  return <div ref={el} style={{ height }} className="w-full" />;
}

"use client";

import { useEffect, useRef } from "react";
import type { HeatColumn } from "@/lib/engine/engine";

/**
 * Liquidity persistence heatmap (OBSERVED resting depth, consolidated across valid books).
 * x = time (1s columns), y = price buckets, colour = log USD resting at that price.
 * Mid-price path is overlaid. Modeled liquidation estimates are NEVER drawn here.
 */
export function Heatmap({ cols, step, height = 360 }: { cols: HeatColumn[]; step: number; height?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = cv.clientHeight;
    cv.width = Math.floor(w * dpr);
    cv.height = Math.floor(h * dpr);
    const g = cv.getContext("2d")!;
    g.scale(dpr, dpr);
    g.fillStyle = "#0B1016";
    g.fillRect(0, 0, w, h);
    if (!cols.length || !step) {
      g.fillStyle = "#5f6f7f";
      g.font = "11px Inter";
      g.fillText("Waiting for valid order books…", 12, 20);
      return;
    }
    const axisW = 64;
    const plotW = w - axisW;
    const last = cols[cols.length - 1];
    // price window: centre on latest mid, ±0.8%
    const pMid = last.mid;
    const pLo = pMid * 0.992, pHi = pMid * 1.008;
    const y = (p: number) => h - ((p - pLo) / (pHi - pLo)) * h;
    const n = Math.min(cols.length, Math.floor(plotW));
    const colW = plotW / n;
    const view = cols.slice(-n);
    // robust colour scale from 98th percentile of visible values
    const sample: number[] = [];
    for (let k = 0; k < view.length; k += Math.max(1, Math.floor(view.length / 60))) for (const v of view[k].vals) if (v > 0) sample.push(v);
    sample.sort((a, b) => a - b);
    const hiV = Math.log1p(sample[Math.floor(sample.length * 0.98)] ?? 1);
    const loV = Math.log1p(sample[Math.floor(sample.length * 0.3)] ?? 0);
    const cellH = Math.max(1, (step / (pHi - pLo)) * h);
    view.forEach((c, k) => {
      const x = k * colW;
      for (let i = 0; i < c.vals.length; i++) {
        const v = c.vals[i];
        if (v <= 0) continue;
        const p = (c.i0 + i) * step;
        if (p < pLo || p > pHi) continue;
        const t = Math.max(0, Math.min(1, (Math.log1p(v) - loV) / Math.max(1e-6, hiV - loV)));
        if (t <= 0.02) continue;
        g.fillStyle = ramp(t, p < c.mid);
        g.fillRect(x, y(p) - cellH / 2, colW + 0.5, cellH + 0.5);
      }
    });
    // mid path
    g.strokeStyle = "#F2F5F7";
    g.lineWidth = 1.25;
    g.beginPath();
    view.forEach((c, k) => { const yy = y(c.mid); if (k === 0) g.moveTo(k * colW, yy); else g.lineTo(k * colW, yy); });
    g.stroke();
    // axis
    g.fillStyle = "#151D26";
    g.fillRect(plotW, 0, axisW, h);
    g.fillStyle = "#94A3B2";
    g.font = "10px Inter";
    for (let k = 0; k <= 8; k++) {
      const p = pLo + ((pHi - pLo) * k) / 8;
      const yy = y(p);
      g.fillText(p.toFixed(p > 1000 ? 0 : 2), plotW + 6, Math.min(h - 3, Math.max(10, yy + 3)));
      g.fillStyle = "#1f2a36";
      g.fillRect(0, yy, plotW, 0.5);
      g.fillStyle = "#94A3B2";
    }
    g.fillStyle = "#F2F5F7";
    g.fillRect(plotW, y(pMid) - 7, axisW, 14);
    g.fillStyle = "#0B1016";
    g.fillText(pMid.toFixed(pMid > 1000 ? 1 : 2), plotW + 6, y(pMid) + 3);
    // time labels
    g.fillStyle = "#5f6f7f";
    const span = (view[view.length - 1].t - view[0].t) / 1000;
    g.fillText(`−${Math.round(span / 60)}m`, 4, h - 4);
    g.fillText("now", plotW - 24, h - 4);
  }, [cols, step, height]);
  return <canvas ref={ref} style={{ height, width: "100%" }} className="block rounded" aria-label="Order book liquidity heatmap" />;
}

function ramp(t: number, bid: boolean) {
  // dark → teal/rose → amber → white for the strongest persistent walls
  if (t < 0.6) {
    const a = 0.15 + t * 1.2;
    return bid ? `rgba(49,185,150,${a})` : `rgba(214,108,120,${a})`;
  }
  if (t < 0.9) return `rgba(217,170,101,${0.6 + (t - 0.6)})`;
  return `rgba(255,244,214,${0.85 + (t - 0.9)})`;
}

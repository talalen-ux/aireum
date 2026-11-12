"use client";

import type { LiqMap } from "@/lib/engine/liqmodel";
import { fmt } from "../ui";

/** MODELED liquidation estimate by price band with low/high scenario whiskers. Purple palette = model. */
export function LiqMapChart({ map, height = 300, window = 0.06 }: { map: LiqMap; height?: number; window?: number }) {
  const rows = map.buckets.filter((b) => Math.abs(b.price / map.price - 1) <= window);
  const max = Math.max(1, ...rows.map((b) => Math.max(b.longHigh, b.shortHigh)));
  const H = height, W = 100;
  const rowH = H / Math.max(1, rows.length);
  const sorted = [...rows].sort((a, b) => b.price - a.price);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }} className="w-full block">
        {sorted.map((b, i) => {
          const y = i * rowH;
          const isLong = b.longUsd > 0;
          const v = isLong ? b.longUsd : b.shortUsd;
          const lo = isLong ? b.longLow : b.shortLow;
          const hi = isLong ? b.longHigh : b.shortHigh;
          if (v <= 0 && hi <= 0) return null;
          const x0 = 50;
          const len = (v / max) * 48;
          return (
            <g key={b.price}>
              <rect x={isLong ? x0 - len : x0} y={y + rowH * 0.1} width={len} height={rowH * 0.8} fill={isLong ? "rgba(214,108,120,0.55)" : "rgba(49,185,150,0.55)"} />
              <line x1={isLong ? x0 - (hi / max) * 48 : x0 + (lo / max) * 48} x2={isLong ? x0 - (lo / max) * 48 : x0 + (hi / max) * 48} y1={y + rowH / 2} y2={y + rowH / 2} stroke="#A58BE0" strokeWidth={0.4} vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
        {(() => {
          const idx = sorted.findIndex((b) => b.price <= map.price);
          const y = idx < 0 ? H : idx * rowH;
          return <line x1={0} x2={W} y1={y} y2={y} stroke="#F2F5F7" strokeDasharray="1 1" strokeWidth={0.6} vectorEffect="non-scaling-stroke" />;
        })()}
        <line x1={50} x2={50} y1={0} y2={H} stroke="#243241" strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-mute tnum">
        <span>← long liq (forced sells) · {fmt.px(sorted[sorted.length - 1]?.price)}</span>
        <span>{fmt.px(sorted[0]?.price)} · short liq (forced buys) →</span>
      </div>
    </div>
  );
}

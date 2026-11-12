"use client";

/** Minimal SVG line chart (one or more series sharing an x axis). */
export function Spark({ series, height = 60, zero = false }: { series: { values: (number | null)[]; color: string; label?: string }[]; height?: number; zero?: boolean }) {
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v)));
  if (all.length < 2) return <div style={{ height }} className="flex items-center justify-center text-[10px] text-mute">warming up…</div>;
  let lo = Math.min(...all), hi = Math.max(...all);
  if (zero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  if (hi === lo) { hi += 1; lo -= 1; }
  const n = Math.max(...series.map((s) => s.values.length));
  const W = 200, H = height;
  const y = (v: number) => H - 2 - ((v - lo) / (hi - lo)) * (H - 4);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full block" style={{ height }}>
      {zero && <line x1={0} x2={W} y1={y(0)} y2={y(0)} stroke="#243241" strokeWidth={1} vectorEffect="non-scaling-stroke" />}
      {series.map((s, k) => {
        let d = "";
        s.values.forEach((v, i) => {
          if (v === null || !Number.isFinite(v)) return;
          const x = (i / Math.max(1, n - 1)) * W;
          d += `${d ? "L" : "M"}${x.toFixed(1)},${y(v).toFixed(1)}`;
        });
        return <path key={k} d={d} fill="none" stroke={s.color} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />;
      })}
    </svg>
  );
}

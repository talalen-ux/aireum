"use client";

import { useMemo, useState } from "react";
import type { Timeframe } from "@/lib/core/types";
import { useAtlas } from "@/lib/state/store";
import { aggregateVol } from "@/lib/engine/dvol";
import { vix2bEventStudy, type HorizonStat } from "@/lib/engine/eventstudy";
import { detect2B, gannFans, GANN_RATIOS, gannLevel, twoBOutcomes, williamsVixFix, wvfState, type GannFan, type GannScaleMode, type TwoB, type VolBar } from "@/lib/engine/technicals";
import { PriceChart } from "../charts/PriceChart";
import { Badge, Card, cn, fmt, ProvTag, Tabs, Unavailable } from "../ui";
import { Loading } from "./CommandView";

const TFS = ["15m", "1h", "4h", "1d"] as const;
type TF = (typeof TFS)[number];

const FAN_COLORS: Record<string, string> = { "8×1": "#5f6f7f", "4×1": "#6aa3d9", "3×1": "#6aa3d9", "2×1": "#a58be0", "1×1": "#d9aa65", "1×2": "#a58be0", "1×3": "#6aa3d9", "1×4": "#6aa3d9", "1×8": "#5f6f7f" };
const STATE_TONE = { pending: "warn", confirmed: "bull", invalidated: "bear", expired: "dim" } as const;

export function TechnicalsView() {
  const snap = useAtlas((s) => s.snap);
  const chartBars = useAtlas((s) => s.chartBars);
  const dvol = useAtlas((s) => s.dvol);
  const vix = useAtlas((s) => s.vix);
  const mode = useAtlas((s) => s.mode);
  const btcDaily = useMemo(() => chartBars["1d"] ?? [], [chartBars]);
  const vixBars = useMemo(() => (vix?.status === "ok" ? vix.bars : []), [vix]);
  const vix2B = useMemo(() => (vixBars.length ? detect2B(vixBars.slice(-400)) : []), [vixBars]);
  const study = useMemo(() => (vixBars.length && btcDaily.length ? vix2bEventStudy(vixBars, btcDaily) : null), [vixBars, btcDaily]);
  const [tf, setTf] = useState<TF>("1h");
  const [scaleMode, setScaleMode] = useState<GannScaleMode>("atr");
  const [fanSel, setFanSel] = useState<"up" | "down" | "both">("both");
  const bars = useMemo(() => chartBars[tf as Timeframe] ?? [], [chartBars, tf]);

  const fans = useMemo(() => gannFans(bars, { scaleMode, lookback: 150, aheadBars: 20 }), [bars, scaleMode]);
  const price2B = useMemo(() => detect2B(bars), [bars]);
  const priceOut = useMemo(() => twoBOutcomes(bars, price2B, 10), [bars, price2B]);

  const wvf = useMemo(() => williamsVixFix(bars), [bars]);
  const dvolSeries: VolBar[] | null = useMemo(() => {
    if (dvol?.status !== "ok") return null;
    if (tf === "1h") return dvol.h1;
    if (tf === "4h") return aggregateVol(dvol.h1, 4);
    if (tf === "1d") return dvol.d1;
    return null;
  }, [dvol, tf]);
  const volSeries = dvolSeries ?? wvf;
  const volName = dvolSeries ? "DVOL — Deribit 30d implied vol index" : "Williams VIX Fix (from price)";
  const vol2B = useMemo(() => detect2B(volSeries), [volSeries]);
  const wvfSt = useMemo(() => wvfState(wvf), [wvf]);
  // vol 2B top → forward asset return (align by time)
  const volOut = useMemo(() => {
    const byT = new Map(bars.map((b, i) => [b.t, i]));
    const r: number[] = [];
    for (const x of vol2B) {
      if (x.kind !== "top" || x.confirmTime === null) continue;
      const i = byT.get(x.confirmTime);
      if (i === undefined || i + 10 >= bars.length) continue;
      r.push((bars[i + 10].c / bars[i].c - 1) * 10_000);
    }
    const so = [...r].sort((a, b) => a - b);
    return { n: r.length, median: so.length ? so[Math.floor(so.length / 2)] : null, hit: r.length ? r.filter((x) => x > 0).length / r.length : null };
  }, [vol2B, bars]);

  const overlay = useMemo(() => {
    const segments: NonNullable<Parameters<typeof PriceChart>[0]["overlay"]>["segments"] = [];
    const n = bars.length;
    for (const fan of [fans.up, fans.down]) {
      if (!fan || (fanSel !== "both" && fanSel !== fan.direction)) continue;
      const endI = n - 1 + fan.aheadBars;
      for (const g of GANN_RATIOS) {
        const vEnd = gannLevel(fan, g.r, endI);
        segments.push({ id: `${fan.direction}${g.label}`, color: FAN_COLORS[g.label], width: g.label === "1×1" ? 2 : 1, dashed: g.label !== "1×1", points: [{ t: fan.pivot.t, v: fan.pivot.price }, { t: bars[n - 1].t + fan.aheadBars * fan.barMs, v: vEnd }] });
      }
    }
    const markers = price2B
      .filter((x) => x.confirmTime !== null && x.state !== "expired")
      .slice(-12)
      .map((x) => ({ t: x.confirmTime!, position: x.kind === "top" ? ("aboveBar" as const) : ("belowBar" as const), color: x.state === "invalidated" ? "#5f6f7f" : x.kind === "top" ? "#D66C78" : "#31B996", text: "2B" }));
    return { segments, markers };
  }, [fans, fanSel, price2B, bars]);

  if (!snap) return <Loading />;
  const px = bars.at(-1)?.c ?? snap.price;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-semibold">VIX 2B · Gann fan</h2>
        <Tabs value={tf} onChange={setTf} items={TFS.map((x) => ({ id: x, label: x }))} />
        <span className="text-[10px] text-mute">Gann 1×1 scale</span>
        <Tabs value={scaleMode} onChange={setScaleMode} items={[{ id: "atr", label: "1 ATR / bar" }, { id: "pivot", label: "pivot → pivot" }]} />
        <Tabs value={fanSel} onChange={setFanSel} items={[{ id: "both", label: "both fans" }, { id: "up", label: "from low" }, { id: "down", label: "from high" }]} />
        <ProvTag p="inferred" />
        <span className="text-[10px] text-mute">Classic technical heuristics — context, not evidence of edge.</span>
      </div>

      <div className="grid gap-3 xl:grid-cols-[1fr_380px]">
        <Card title={`${snap.asset} ${tf} · Gann fans & 2B reversals`} subtitle="Solid amber = 1×1 · dashed = other angles · ▲▼ 2B = confirmed failed breakdown / breakout (grey = later invalidated)" bodyClass="p-0">
          {bars.length ? <PriceChart key={tf} bars={bars} overlay={overlay} height={460} /> : <div className="h-[460px] flex items-center justify-center text-[11px] text-mute">Loading history…</div>}
        </Card>
        <Card title="VIX 2B — volatility" subtitle={volName} right={<ProvTag p={dvolSeries ? "observed" : "modeled"} />}>
          {volSeries.length > 30 ? (
            <>
              <VolChart series={volSeries.slice(-200)} signals={vol2B} />
              <div className="mt-2 grid grid-cols-3 gap-2 text-[11px] tnum">
                <div><div className="text-[10px] text-mute">Now</div>{volSeries.at(-1)!.c.toFixed(2)}</div>
                <div><div className="text-[10px] text-mute">WVF percentile</div>{wvfSt ? `${Math.round(wvfSt.percentile * 100)}%` : "—"}</div>
                <div><div className="text-[10px] text-mute">WVF spike</div>{wvfSt ? <span className={wvfSt.spike ? "text-warn" : "text-dim"}>{wvfSt.spike ? "YES (fear)" : "no"}</span> : "—"}</div>
              </div>
              {!dvolSeries && <p className="mt-1 text-[10px] text-mute">{tf === "15m" ? "DVOL is hourly; 15m uses the price-derived VIX Fix." : dvol?.status === "unavailable" ? `DVOL unavailable: ${dvol.reason}. Using VIX Fix.` : "DVOL loads in Live mode; using VIX Fix."}</p>}
              <h4 className="mt-3 mb-1 text-[10px] uppercase tracking-wider text-dim">Recent volatility 2Bs</h4>
              <TwoBList list={vol2B.slice(-6).reverse()} digits={2} meaning={(x) => (x.kind === "top" ? "fear spike failed → bullish context" : "complacency broke → vol-expansion risk")} />
              <div className="mt-2 rounded border border-line/60 p-2 text-[10px] text-dim tnum">
                In-sample, this series: vol-2B tops → asset +10 bars: n={volOut.n}, median {fmt.bps(volOut.median)}, up {volOut.hit !== null ? Math.round(volOut.hit * 100) + "%" : "—"}. Descriptive only; before costs.
              </div>
            </>
          ) : <Unavailable reason="not enough bars" />}
        </Card>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="Gann fan analysis" subtitle={fans.up ? `1×1 = ${fmt.px(fans.up.scale, 2)} per bar (${scaleMode === "atr" ? "ATR(14)" : "pivot-to-pivot fit"})` : ""} right={<ProvTag p="inferred" />}>
          <div className="grid gap-3 md:grid-cols-2">
            <FanTable fan={fans.up} price={px} title="From swing low (rising)" />
            <FanTable fan={fans.down} price={px} title="From swing high (falling)" />
          </div>
          <p className="mt-2 text-[10px] text-mute">Gann angles depend entirely on the chosen price-per-bar scale — change the scale and every line moves. Pivots are the most extreme confirmed fractal swings (k=5) in the last 150 bars. Gann convention: holding above the rising 1×1 means the trend is intact; losing it points to the next flatter angle (1×2) as support. Treated as inferred context, never as proof.</p>
        </Card>
        <Card title="2B reversals — price" subtitle={`${tf} · break of last confirmed swing pivot, close back inside ≤3 bars`} right={<ProvTag p="observed" />}>
          <TwoBList list={price2B.slice(-8).reverse()} digits={1} meaning={(x) => (x.kind === "top" ? "failed breakout → short hypothesis" : "failed breakdown → long hypothesis")} />
          <div className="mt-2 rounded border border-line/60 p-2 text-[10px] text-dim tnum">
            In-sample, {priceOut.horizon} bars after confirmation: tops n={priceOut.top.n}, median {fmt.bps(priceOut.top.median)}, fell {priceOut.top.hit !== null ? Math.round(priceOut.top.hit * 100) + "%" : "—"} · bottoms n={priceOut.bottom.n}, median {fmt.bps(priceOut.bottom.median)}, rose {priceOut.bottom.hit !== null ? Math.round(priceOut.bottom.hit * 100) + "%" : "—"}. Before costs; overlapping signals; not validated.
          </div>
        </Card>
      </div>

      <Card title="CBOE VIX 2B → crypto (cross-asset)" subtitle={vix?.status === "ok" ? `${vix.source} · last ${fmt.time(vixBars.at(-1)?.t)} · event study vs ${snap.asset} daily closes` : "Equity fear gauge 2B reversals and what BTC did next"} right={<ProvTag p="observed" />}>
        {mode !== "live" ? (
          <Unavailable reason={`real CBOE VIX is only paired with live ${snap.asset} data — switch to Live (mixing a real VIX with ${mode} prices would be meaningless)`} />
        ) : vix?.status !== "ok" ? (
          <Unavailable reason={vix ? vix.reason : "loading CBOE VIX…"} />
        ) : (
          <div className="grid gap-4 xl:grid-cols-[380px_1fr]">
            <div>
              <VolChart series={vixBars.slice(-200)} signals={vix2B} />
              <div className="mt-1 flex gap-4 text-[11px] tnum"><span>VIX {vixBars.at(-1)!.c.toFixed(2)}</span><span className="text-mute">{vix.ohlc ? "daily OHLC" : "close-only (FRED) — 2B on closes"}</span></div>
              <h4 className="mt-3 mb-1 text-[10px] uppercase tracking-wider text-dim">Recent VIX 2Bs</h4>
              <TwoBList list={vix2B.slice(-5).reverse()} digits={2} meaning={(x) => (x.kind === "top" ? "equity fear spike failed → risk-on context for crypto" : "complacency broke → risk-off / vol-expansion risk")} />
            </div>
            <div>
              {study ? (
                <>
                  <p className="text-[11px] text-dim mb-2">Sample {new Date(study.sample.from).toISOString().slice(0, 10)} → {new Date(study.sample.to).toISOString().slice(0, 10)} · {study.sample.btcDays} BTC days. Forward {snap.asset} returns after confirmed VIX 2Bs vs all days.</p>
                  <StudyTable title="VIX 2B top (fear fails) → expect crypto UP" rows={study.top} tone="bull" />
                  <StudyTable title="VIX 2B bottom (complacency breaks) → expect crypto DOWN" rows={study.bottom} tone="bear" />
                  <ul className="mt-2 list-disc pl-4 text-[10px] text-mute space-y-0.5">{study.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
                  <p className="mt-1 text-[10px] text-mute">History depth is limited by the {btcDaily.length} daily bars loaded (Binance limit). For a longer, out-of-sample test use <code>research/</code>.</p>
                </>
              ) : <Unavailable reason="needs ≥60 overlapping days of VIX and daily bars" />}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function StudyTable({ title, rows, tone }: { title: string; rows: HorizonStat[]; tone: "bull" | "bear" }) {
  return (
    <div className="mb-3">
      <h4 className={cn("text-[11px] mb-1", tone === "bull" ? "text-bull" : "text-bear")}>{title}</h4>
      <table className="w-full text-[11px] tnum">
        <thead><tr className="text-left text-mute">{["Horizon", "n", "Mean", "Median", "Hit", "Baseline mean", "Baseline hit", "Edge vs baseline", "p (perm.)"].map((h) => <th key={h} className="font-normal pr-2">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.h} className="border-t border-line/30">
              <td className="py-0.5">{r.h}d</td>
              <td className={r.n < 15 ? "text-warn" : ""}>{r.n}</td>
              <td>{fmt.bps(r.mean, 0)}</td>
              <td>{fmt.bps(r.median, 0)}</td>
              <td>{r.hit !== null ? `${Math.round(r.hit * 100)}%` : "—"}</td>
              <td className="text-mute">{fmt.bps(r.baselineMean, 0)}</td>
              <td className="text-mute">{r.baselineHit !== null ? `${Math.round(r.baselineHit * 100)}%` : "—"}</td>
              <td className={(r.edgeBps ?? 0) > 0 ? "text-bull" : "text-bear"}>{fmt.bps(r.edgeBps, 0)}</td>
              <td className={r.pValue !== null && r.pValue < 0.05 ? "text-bull font-semibold" : "text-dim"}>{r.pValue !== null ? r.pValue.toFixed(3) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TwoBList({ list, digits, meaning }: { list: TwoB[]; digits: number; meaning: (x: TwoB) => string }) {
  if (!list.length) return <p className="text-[11px] text-mute">None in the visible window.</p>;
  return (
    <ul className="space-y-1.5 text-[11px]">
      {list.map((x, i) => (
        <li key={i} className="border-b border-line/30 pb-1">
          <div className="flex items-center gap-2">
            <span className={x.kind === "top" ? "text-bear" : "text-bull"}>2B {x.kind}</span>
            <Badge tone={STATE_TONE[x.state]}>{x.state}</Badge>
            <span className="ml-auto text-[10px] text-mute tnum">{new Date(x.confirmTime ?? x.breakTime).toISOString().slice(5, 16).replace("T", " ")}</span>
          </div>
          <div className="tnum text-dim">pivot {x.trigger.toFixed(digits)} · extreme {x.extreme.toFixed(digits)} · invalid {x.invalidation.toFixed(digits)}</div>
          <div className="text-[10px] text-mute">{meaning(x)}</div>
        </li>
      ))}
    </ul>
  );
}

function FanTable({ fan, price, title }: { fan: GannFan | null; price: number | null; title: string }) {
  if (!fan) return <div><h4 className="text-[11px] text-dim mb-1">{title}</h4><Unavailable reason="no qualifying pivot" /></div>;
  const lines = [...fan.lines].sort((a, b) => b.levelNow - a.levelNow);
  return (
    <div>
      <h4 className="text-[11px] text-dim">{title}</h4>
      <div className="text-[10px] text-mute tnum mb-1">pivot {fmt.px(fan.pivot.price)} @ {new Date(fan.pivot.t).toISOString().slice(5, 16).replace("T", " ")}</div>
      <table className="w-full text-[11px] tnum">
        <thead><tr className="text-mute text-left"><th className="font-normal">Angle</th><th className="font-normal text-right">Now</th><th className="font-normal text-right">+{fan.aheadBars} bars</th><th className="font-normal text-right">Dist</th></tr></thead>
        <tbody>
          {lines.map((l) => {
            const isS = fan.nearestSupport?.label === l.label, isR = fan.nearestResistance?.label === l.label;
            const off = l.levelNow <= 0 || (price !== null && Math.abs(l.levelNow / price - 1) > 0.3);
            const lv = (v: number) => (v <= 0 ? "< 0" : fmt.px(v));
            return (
              <tr key={l.label} className={cn("border-t border-line/30", (isS || isR) && "bg-elev/60", off && "opacity-40")} title={off ? "Off-range: more than 30% from price at this scale" : undefined}>
                <td className={cn(l.label === "1×1" ? "text-warn font-semibold" : "text-dim")}>{l.label}{isS ? " ▲S" : isR ? " ▼R" : ""}</td>
                <td className="text-right">{lv(l.levelNow)}</td>
                <td className="text-right text-mute">{lv(l.levelAhead)}</td>
                <td className="text-right text-mute">{price && !off ? fmt.pct(l.levelNow / price - 1) : "off-range"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="mt-1 text-[10px]">
        <span className={fan.aboveOneByOne ? "text-bull" : "text-bear"}>{fan.aboveOneByOne ? "Above" : "Below"} 1×1</span>
        <span className="text-mute"> · between {fan.between[0] ?? "—"} and {fan.between[1] ?? "—"}</span>
        {fan.recentBreaks.length > 0 && <div className="text-warn">Crossed: {fan.recentBreaks.map((b) => `${b.label} ${b.dir === "up" ? "↑" : "↓"} (${b.barsAgo}b ago)`).join(", ")}</div>}
      </div>
    </div>
  );
}

function VolChart({ series, signals }: { series: VolBar[]; signals: TwoB[] }) {
  const W = 360, H = 130, pad = 4;
  const lo = Math.min(...series.map((s) => s.l)), hi = Math.max(...series.map((s) => s.h));
  const x = (i: number) => pad + (i / Math.max(1, series.length - 1)) * (W - 2 * pad);
  const y = (v: number) => H - pad - ((v - lo) / Math.max(1e-9, hi - lo)) * (H - 2 * pad);
  const idx = new Map(series.map((s, i) => [s.t, i]));
  const path = series.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(s.c).toFixed(1)}`).join("");
  const band = series.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(s.h).toFixed(1)}`).join("") + [...series].reverse().map((s, k) => `L${x(series.length - 1 - k).toFixed(1)},${y(s.l).toFixed(1)}`).join("") + "Z";
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full h-auto" role="img" aria-label="Volatility index with 2B signals">
      <path d={band} fill="rgba(165,139,224,0.15)" />
      <path d={path} fill="none" stroke="#A58BE0" strokeWidth={1.3} />
      {signals.map((s, k) => {
        const i = s.confirmTime !== null ? idx.get(s.confirmTime) : undefined;
        if (i === undefined) return null;
        const top = s.kind === "top";
        const yy = y(series[i].c);
        const col = s.state === "invalidated" ? "#5f6f7f" : top ? "#31B996" : "#D9AA65";
        return (
          <g key={k}>
            <line x1={x(idx.get(s.pivot.t) ?? i)} x2={x(i)} y1={y(s.trigger)} y2={y(s.trigger)} stroke={col} strokeDasharray="2 2" strokeWidth={0.8} />
            <path d={top ? `M${x(i) - 4},${yy - 9} L${x(i) + 4},${yy - 9} L${x(i)},${yy - 3}Z` : `M${x(i) - 4},${yy + 9} L${x(i) + 4},${yy + 9} L${x(i)},${yy + 3}Z`} fill={col} />
          </g>
        );
      })}
      <text x={W - pad} y={11} textAnchor="end" fontSize={9} fill="#5f6f7f">{hi.toFixed(1)}</text>
      <text x={W - pad} y={H - 6} textAnchor="end" fontSize={9} fill="#5f6f7f">{lo.toFixed(1)}</text>
    </svg>
  );
}

"use client";

import { useMemo, useState } from "react";
import type { Evidence, Timeframe } from "@/lib/core/types";
import { useAtlas } from "@/lib/state/store";
import { PriceChart } from "../charts/PriceChart";
import { Badge, Card, cn, fmt, ProvTag, Tabs, Unavailable } from "../ui";
import { ExhaustionPanel, OpportunityCard, pressureLabel, RegimeStrip, ScoreTile } from "../widgets";
import { loadPositions } from "../views/positions";

export function CommandView() {
  const snap = useAtlas((s) => s.snap);
  const chartBars = useAtlas((s) => s.chartBars);
  const bars1m = useAtlas((s) => s.bars1m);
  const tf = useAtlas((s) => s.chartTf);
  const setTf = useAtlas((s) => s.setChartTf);
  const setView = useAtlas((s) => s.setView);
  const [selected, setSelected] = useState<string | null>(null);

  const scoreTf: Timeframe = "15m";
  const a = snap?.assessments[scoreTf];
  const a1h = snap?.assessments["1h"];
  const opps = snap?.opportunities ?? [];
  const topLong = opps.find((o) => o.side === "long");
  const topShort = opps.find((o) => o.side === "short");
  const sel = opps.find((o) => o.key === selected) ?? topLong ?? topShort ?? null;
  const bars = tf === "1m" ? bars1m : chartBars[tf] ?? [];

  const overlay = useMemo(() => {
    const lm = snap?.liqMap;
    const liqClusters = [lm?.nearestLongCluster ? { price: lm.nearestLongCluster.price, side: "long" as const, usd: lm.nearestLongCluster.usd } : null, lm?.nearestShortCluster ? { price: lm.nearestShortCluster.price, side: "short" as const, usd: lm.nearestShortCluster.usd } : null].filter((x): x is NonNullable<typeof x> => !!x);
    return { opportunity: sel, walls: snap?.walls.slice(0, 4), liqClusters };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel?.key, sel?.state, snap?.liqMap?.nearestLongCluster?.price, snap?.liqMap?.nearestShortCluster?.price, snap?.walls.length]);

  if (!snap) return <Loading />;
  const ts = snap.ts;
  const ev = (label: string, value: string, stance: 1 | -1 | 0, provenance: Evidence["provenance"] = "observed", source = `${scoreTf} features`): Evidence => ({ label, value, stance, provenance, source, ts });
  const f = a?.features;

  return (
    <div className="flex flex-col gap-3">
      <RegimeStrip assess={snap.assessments} />

      <div className="grid gap-2 grid-cols-2 md:grid-cols-3 xl:grid-cols-6">
        <ScoreTile title="Directional pressure" value={a?.directionalPressure ?? null} diverging display={pressureLabel(a?.directionalPressure ?? null)}
          evidence={f ? [ev("Momentum (vol-adj)", fmt.z(f.z.mom), (f.z.mom ?? 0) > 0 ? 1 : -1), ev("Spot flow", fmt.z(f.z.spotFlow), (f.z.spotFlow ?? 0) > 0 ? 1 : -1), ev("Perp flow", fmt.z(f.z.perpFlow), (f.z.perpFlow ?? 0) > 0 ? 1 : -1), ev("OI change", fmt.z(f.z.oiChg), 0), ev("Liq imbalance", f.raw.liqImb?.toFixed(2) ?? "n/a", 0)] : []}
          note="Weighted robust z-scores (15m). + = net buy-side pressure." />
        <ScoreTile title="Liquidity fragility" value={a?.liquidityFragility ?? null} display={a?.liquidityFragility == null ? "—" : `${Math.round(a.liquidityFragility * 100)}/100`}
          evidence={[ev("Vol ratio", fmt.z(f?.z.volRatio), 0), ev("Impact (Kyle λ)", fmt.z(f?.z.impact), 0, "modeled"), ev("Agg. depth ±100bp", snap.aggDepth ? `${fmt.usd(snap.aggDepth.bid100)} / ${fmt.usd(snap.aggDepth.ask100)}` : "n/a", 0, "observed", "live books")]} />
        <ScoreTile title="Reversal potential" value={a?.reversalPotential ?? null} tone="warn" display={a?.reversalPotential == null ? "—" : `${Math.round(a.reversalPotential * 100)}/100`}
          evidence={[ev("Range position", f?.raw.rangePos != null ? `${Math.round(f.raw.rangePos * 100)}%` : "n/a", 0), ev("Momentum stretch", fmt.z(f?.z.mom), 0), ev("Exhaustion (long)", snap.exhaustion.long ? `${Math.round(snap.exhaustion.long.strength * 100)}` : "n/a", 0, "modeled", "exhaustion engine"), ev("Exhaustion (short)", snap.exhaustion.short ? `${Math.round(snap.exhaustion.short.strength * 100)}` : "n/a", 0, "modeled", "exhaustion engine")]} />
        <ScoreTile title="Crowding / squeeze" value={a1h?.crowding ?? null} tone="bear" display={a1h?.crowding == null ? "—" : `${Math.round(a1h.crowding * 100)}/100 ${a1h.crowdedSide ?? ""}`}
          evidence={[ev("Funding (1h z)", fmt.z(a1h?.features?.z.funding), 0, "observed", "1h features"), ev("Basis (1h z)", fmt.z(a1h?.features?.z.basis), 0, "observed", "1h features"), ev("OI change (1h z)", fmt.z(a1h?.features?.z.oiChg), 0, "observed", "1h features"), ev("Avg funding (live)", snap.fundingAvg8h !== null ? `${(snap.fundingAvg8h * 1e4).toFixed(2)}bp/8h` : "n/a", 0, "observed", "venue funding")]} note="Crowded side = side paying to hold; squeeze risk falls on that side." />
        <ScoreTile title="Spot vs derivatives" value={f?.raw.spotShare ?? null} tone="info" display={a?.leadership ? `${a.leadership}-led` : "—"}
          evidence={[ev("Spot share of volume", f?.raw.spotShare != null ? `${Math.round(f.raw.spotShare * 100)}%` : "n/a", 0), ev("Spot flow z", fmt.z(f?.z.spotFlow), 0), ev("Perp flow z", fmt.z(f?.z.perpFlow), 0), ev("Lead venue (xcorr)", snap.leadLag?.leader ?? "none", 0, "modeled", "lead-lag")]} />
        <ScoreTile title="Data confidence" value={a?.dataConfidence ?? null} tone="info" display={a ? `${Math.round(a.dataConfidence * 100)}%` : "—"}
          evidence={[ev("Live feeds", `${snap.liveVenues}/${snap.totalStreams}`, snap.liveVenues > 2 ? 1 : -1, "observed", "feed health"), ev("History", snap.history.source, snap.history.loaded ? 1 : -1, "observed", "bootstrap"), ev("Historical flow", snap.history.flowAvailable ? "available" : "unavailable", snap.history.flowAvailable ? 1 : -1, "observed", "bootstrap"), ...snap.history.errors.slice(0, 3).map((e) => ev("Issue", e, -1 as const, "observed", "bootstrap"))]} />
      </div>

      <div className="grid gap-3 xl:grid-cols-[1fr_360px] max-lg:order-last">
        <Card title={`${snap.asset} · price, signed flow & OI`} subtitle="Pane 2: spot Δ (bars) vs perp Δ (line) · Pane 3: open interest · dots: observed liquidations" right={<Tabs value={tf} onChange={setTf} items={(["1m", "5m", "15m", "1h", "4h", "1d"] as const).map((x) => ({ id: x, label: x }))} />} bodyClass="p-0">
          {bars.length ? <PriceChart bars={bars} overlay={overlay} height={430} /> : <div className="h-[430px] flex items-center justify-center text-[11px] text-mute">{tf === "1m" ? "1m bars build from live trades…" : "Loading history…"}</div>}
        </Card>
        <div className="space-y-3">
          <Card title="Liquidity Exhaustion & Reversal Engine" subtitle={`${snap.exhaustion.tf} bars · primary differentiator · research signal`} right={<ProvTag p="modeled" />}>
            <div className="grid gap-2">
              <ExhaustionPanel sig={snap.exhaustion.long} label="Downside exhaustion → long hypothesis" />
              <ExhaustionPanel sig={snap.exhaustion.short} label="Upside exhaustion → short hypothesis" />
            </div>
          </Card>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-bull">Highest-priority long</h3>
          {topLong ? <OpportunityCard o={topLong} price={snap.price} compact onSelect={() => setSelected(topLong.key)} selected={sel?.key === topLong.key} /> : <Empty text="No long hypothesis currently meets evidence thresholds." />}
        </div>
        <div className="space-y-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-bear">Highest-priority short</h3>
          {topShort ? <OpportunityCard o={topShort} price={snap.price} compact onSelect={() => setSelected(topShort.key)} selected={sel?.key === topShort.key} /> : <Empty text="No short hypothesis currently meets evidence thresholds." />}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card title="Nearby resting liquidity" subtitle="Largest walls ≤150bp · observed" right={<ProvTag p="observed" />}>
          {snap.walls.length ? (
            <ul className="space-y-1 text-[11px]">
              {snap.walls.slice(0, 7).map((w) => (
                <li key={w.key} className="flex items-center gap-2 tnum">
                  <span className={cn("w-8", w.side === "bid" ? "text-bull" : "text-bear")}>{w.side}</span>
                  <span className="flex-1">{fmt.px(w.price)}</span>
                  <span className="text-dim">{fmt.usd(w.usd)}</span>
                  <span className="w-14 text-right text-mute">{fmt.bps(w.distBps, 0)}</span>
                  <span className="w-10 text-right text-mute">{Math.round(w.ageSec)}s</span>
                </li>
              ))}
            </ul>
          ) : <Unavailable reason="no valid live books" />}
          <p className="mt-2 text-[10px] text-mute">Resting orders can be cancelled at any time. Pulled-before-touch events are tracked as unverified spoof-like behaviour.</p>
        </Card>
        <Card title="Modeled liquidation clusters" subtitle="Estimated, not observable" right={<ProvTag p="modeled" />}>
          {snap.liqMap ? (
            <div className="space-y-2 text-[11px]">
              <Cluster label="Nearest major long-liq band (below)" c={snap.liqMap.nearestLongCluster} tone="bear" />
              <Cluster label="Nearest major short-liq band (above)" c={snap.liqMap.nearestShortCluster} tone="bull" />
              <button type="button" className="text-[10px] text-info cursor-pointer" onClick={() => setView("flow")}>full map & assumptions →</button>
            </div>
          ) : <Unavailable reason="needs OI history" />}
        </Card>
        <Card title="Catalysts" subtitle="Scheduled & venue events">
          <Catalysts />
        </Card>
        <Card title="Connected position risk" subtitle="Read-only · simulation separated from execution">
          <PositionRisk price={snap.price} />
        </Card>
      </div>
    </div>
  );
}

function Cluster({ label, c, tone }: { label: string; c: { price: number; usd: number; distPct: number } | null; tone: "bull" | "bear" }) {
  return (
    <div>
      <div className="text-[10px] text-mute">{label}</div>
      {c ? <div className="tnum"><span className={tone === "bull" ? "text-bull" : "text-bear"}>{fmt.px(c.price)}</span> <span className="text-dim">({fmt.pct(c.distPct)})</span> <span className="text-model">~{fmt.usd(c.usd)}</span></div> : <div className="text-mute">none above 2× mean density</div>}
    </div>
  );
}

function Catalysts() {
  const snap = useAtlas((s) => s.snap)!;
  const perps = snap.venues.filter((v) => v.market === "perp" && v.funding8h !== null);
  return (
    <div className="space-y-2 text-[11px]">
      <Unavailable reason="macro calendar not connected (Macro tab)" />
      <div>
        <div className="text-[10px] text-mute">Funding (live venues)</div>
        {perps.length ? perps.slice(0, 4).map((p) => (
          <div key={p.key} className="flex justify-between tnum"><span className="text-dim">{p.venue}</span><span className={(p.funding8h ?? 0) >= 0 ? "text-bull" : "text-bear"}>{((p.funding8h ?? 0) * 1e4).toFixed(2)}bp/8h</span></div>
        )) : <span className="text-mute">—</span>}
      </div>
      <div className="text-[10px] text-mute">Options expiries: see Options tab (Deribit).</div>
    </div>
  );
}

function PositionRisk({ price }: { price: number | null }) {
  const setView = useAtlas((s) => s.setView);
  const pos = loadPositions();
  if (!pos.length) return (
    <div className="space-y-2">
      <Unavailable reason="no positions — exchange read-only connection is Phase 3" />
      <button type="button" onClick={() => setView("tradelab")} className="text-[10px] text-info cursor-pointer">model a position in Trade Lab →</button>
    </div>
  );
  return (
    <ul className="space-y-1 text-[11px]">
      {pos.map((p, i) => {
        const dist = price ? (p.liq - price) / price : null;
        return <li key={i} className="flex justify-between tnum"><span className={p.side === "long" ? "text-bull" : "text-bear"}>{p.side} {p.qty}</span><span>liq {fmt.px(p.liq)}</span><span className={dist !== null && Math.abs(dist) < 0.03 ? "text-bear" : "text-dim"}>{fmt.pct(dist)}</span></li>;
      })}
    </ul>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="rounded-lg border border-dashed border-line p-4 text-[11px] text-mute">{text}</div>;
}

export function Loading() {
  const mode = useAtlas((s) => s.mode);
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
      <div className="h-6 w-6 rounded-full border-2 border-bull border-t-transparent animate-spin" />
      <p className="text-[12px] text-dim">{mode === "live" ? "Connecting to venue feeds and loading point-in-time history…" : mode === "simulation" ? "Starting synthetic market…" : "Loading replay…"}</p>
      {mode === "live" && <p className="max-w-md text-[11px] text-mute">Feeds connect directly from your browser to public exchange WebSockets. Venues blocked in your region or by CORS are shown as Unavailable — never filled with invented data. Switch to <Badge tone="warn">Simulation</Badge> to explore offline.</p>}
    </div>
  );
}

"use client";

import { useAtlas } from "@/lib/state/store";
import { Heatmap } from "../charts/Heatmap";
import { Badge, Card, cn, fmt, Meter, ProvTag, Unavailable } from "../ui";
import { Loading } from "./CommandView";
import type { FeedState } from "@/lib/core/types";

const STATE_TONE: Record<FeedState, "bull" | "bear" | "warn" | "dim" | "info"> = { live: "bull", connecting: "dim", syncing: "info", gap_recovering: "warn", stale: "warn", disconnected: "bear", unavailable: "bear" };

export function LiquidityView() {
  const snap = useAtlas((s) => s.snap);
  const heat = useAtlas((s) => s.heat);
  const step = useAtlas((s) => s.heatStep);
  if (!snap) return <Loading />;
  const ll = snap.leadLag;
  const imp = snap.impact;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 xl:grid-cols-[1fr_340px]">
        <Card title="Liquidity persistence heatmap" subtitle={`Consolidated resting depth across ${snap.venues.filter((v) => v.state === "live" && v.levels > 0).length} valid books · 1s columns · ±0.8%`} right={<ProvTag p="observed" />} bodyClass="p-1">
          <Heatmap cols={heat} step={step} height={380} />
        </Card>
        <div className="space-y-3">
          <Card title="Aggregate book" subtitle="Valid live books only" right={<ProvTag p="observed" />}>
            {snap.aggDepth ? (
              <div className="space-y-2 text-[11px]">
                <DepthRow label="±25bp" bid={snap.aggDepth.bid25} ask={snap.aggDepth.ask25} />
                <DepthRow label="±100bp" bid={snap.aggDepth.bid100} ask={snap.aggDepth.ask100} />
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <div><div className="text-[10px] text-mute">Bid replenishment (60s)</div><div className="tnum">{snap.bookPressure?.bidReplenish != null ? `${Math.round(snap.bookPressure.bidReplenish * 100)}% adds` : "—"}</div></div>
                  <div><div className="text-[10px] text-mute">Ask replenishment (60s)</div><div className="tnum">{snap.bookPressure?.askReplenish != null ? `${Math.round(snap.bookPressure.askReplenish * 100)}% adds` : "—"}</div></div>
                </div>
              </div>
            ) : <Unavailable reason="no valid books" />}
          </Card>
          <Card title="Price response asymmetry" subtitle={imp ? `10s buckets · last ${Math.round(imp.windowSec / 60)}m · regression through origin` : ""} right={<ProvTag p="modeled" />}>
            {imp && (imp.buyBpsPer1M !== null || imp.sellBpsPer1M !== null) ? (
              <div className="space-y-1 text-[11px]">
                <div className="flex justify-between"><span className="text-dim">+$1M net aggressive buying</span><span className="tnum text-bull">{fmt.bps(imp.buyBpsPer1M, 2)} <span className="text-mute">(n={imp.nBuy})</span></span></div>
                <div className="flex justify-between"><span className="text-dim">+$1M net aggressive selling</span><span className="tnum text-bear">{fmt.bps(imp.sellBpsPer1M !== null ? -imp.sellBpsPer1M : null, 2)} <span className="text-mute">(n={imp.nSell})</span></span></div>
                {imp.buyBpsPer1M !== null && imp.sellBpsPer1M !== null && imp.sellBpsPer1M > 0 && (
                  <p className="pt-1 text-[10px] text-mute">Buy/sell impact ratio {(imp.buyBpsPer1M / imp.sellBpsPer1M).toFixed(2)} — {imp.buyBpsPer1M < imp.sellBpsPer1M ? "buying is being absorbed more than selling (offers replenishing)" : "selling is being absorbed more than buying (bids replenishing)"}.</p>
                )}
              </div>
            ) : <p className="text-[11px] text-mute">Needs ≥6 buckets per side.</p>}
          </Card>
          <Card title="Cross-venue lead–lag" subtitle={ll ? `1s mid returns · xcorr ±5s · ${ll.windowSec}s window` : ""} right={<ProvTag p="modeled" />}>
            {ll && ll.scores.length ? (
              <ul className="space-y-1 text-[11px]">
                {ll.scores.slice(0, 7).map((s) => (
                  <li key={s.key} className="flex items-center gap-2">
                    <span className={cn("w-28 truncate", ll.leader === s.key ? "text-warn font-semibold" : "text-dim")}>{s.key}{ll.leader === s.key ? " ★" : ""}</span>
                    <span className="flex-1"><Meter value={Math.max(-1, Math.min(1, s.leadScore))} diverging /></span>
                    <span className="w-12 text-right tnum text-mute">{s.leadScore.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            ) : <p className="text-[11px] text-mute">Needs ≥150s of mids from ≥2 venues.</p>}
          </Card>
        </div>
      </div>

      <Card title="Venue books" subtitle="Reconstructed L2: snapshot + sequenced deltas · gaps trigger resync · values from invalid books are withheld" bodyClass="p-0 overflow-x-auto">
        <table className="w-full min-w-[980px] text-[11px]">
          <thead>
            <tr className="text-left text-mute border-b border-line/60">
              {["Venue", "State", "Mid", "Disloc.", "Spread", "Microprice", "Imb 10bp", "Imb 25bp", "Imb 100bp", "Bid ≤100bp", "Ask ≤100bp", "Slip $1M B/S", "Repl. B/A", "Latency", "Age", "Gaps", "Lvls"].map((h) => <th key={h} className="px-2 py-1.5 font-normal whitespace-nowrap">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {snap.venues.map((v) => (
              <tr key={v.key} className="border-b border-line/30 hover:bg-elev/40" title={v.detail}>
                <td className="px-2 py-1 whitespace-nowrap"><span className="text-fg">{v.venue}</span> <span className="text-mute">{v.market}</span></td>
                <td className="px-2"><Badge tone={STATE_TONE[v.state]}>{v.state.replace("_", " ")}</Badge></td>
                <td className="px-2 tnum">{fmt.px(v.mid)}</td>
                <td className={cn("px-2 tnum", Math.abs(v.dislocationBps ?? 0) > 5 ? "text-warn" : "text-dim")}>{fmt.bps(v.dislocationBps)}</td>
                <td className="px-2 tnum text-dim">{v.spreadBps !== null ? `${v.spreadBps.toFixed(2)}bp` : "—"}</td>
                <td className="px-2 tnum">{fmt.px(v.microprice)}</td>
                {[v.imb10, v.imb25, v.imb100].map((x, i) => <td key={i} className={cn("px-2 tnum", x === null ? "text-mute" : x > 0.15 ? "text-bull" : x < -0.15 ? "text-bear" : "text-dim")}>{x === null ? "—" : x.toFixed(2)}</td>)}
                <td className="px-2 tnum text-bull/90">{fmt.usd(v.depthBid100Usd)}</td>
                <td className="px-2 tnum text-bear/90">{fmt.usd(v.depthAsk100Usd)}</td>
                <td className="px-2 tnum text-dim">{v.slip1mBuyBps !== null ? v.slip1mBuyBps.toFixed(1) : "—"}/{v.slip1mSellBps !== null ? v.slip1mSellBps.toFixed(1) : "—"}</td>
                <td className="px-2 tnum text-dim">{v.bidReplenish !== null ? Math.round(v.bidReplenish * 100) : "—"}/{v.askReplenish !== null ? Math.round(v.askReplenish * 100) : "—"}</td>
                <td className="px-2 tnum text-dim">{fmt.age(v.latencyMs)}</td>
                <td className={cn("px-2 tnum", (v.ageMs ?? 0) > 5000 ? "text-warn" : "text-dim")}>{fmt.age(v.ageMs)}</td>
                <td className={cn("px-2 tnum", v.gaps ? "text-warn" : "text-mute")}>{v.gaps}</td>
                <td className="px-2 tnum text-mute">{v.levels}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <Card title="Walls (largest resting levels ≤150bp)" right={<ProvTag p="observed" />}>
          {snap.walls.length ? (
            <table className="w-full text-[11px] tnum">
              <thead><tr className="text-mute text-left"><th className="font-normal">Side</th><th className="font-normal">Price</th><th className="font-normal text-right">Size</th><th className="font-normal text-right">Dist</th><th className="font-normal text-right">Persisted</th><th className="font-normal text-right">Venue</th></tr></thead>
              <tbody>{snap.walls.map((w) => <tr key={w.key} className="border-t border-line/30"><td className={w.side === "bid" ? "text-bull" : "text-bear"}>{w.side}</td><td>{fmt.px(w.price)}</td><td className="text-right">{fmt.usd(w.usd)}</td><td className="text-right text-dim">{fmt.bps(w.distBps, 0)}</td><td className="text-right text-dim">{fmt.age(w.ageSec * 1000)}</td><td className="text-right text-mute">{w.key.split("|")[0]}</td></tr>)}</tbody>
            </table>
          ) : <Unavailable reason="no valid books" />}
        </Card>
        <Card title="Pulled before touch — spoof-like (UNVERIFIED)" subtitle="Large level persisted ≥10s, price came within 15bp, level vanished without trading through" right={<ProvTag p="inferred" />}>
          {snap.pulledWalls.length ? (
            <ul className="space-y-1 text-[11px] tnum">
              {snap.pulledWalls.map((p, i) => <li key={i} className="flex justify-between"><span className="text-mute">{fmt.time(p.ts)}</span><span className={p.side === "bid" ? "text-bull" : "text-bear"}>{p.side} {fmt.px(p.price)}</span><span>{fmt.usd(p.usd)}</span><span className="text-mute">{p.venue}</span></li>)}
            </ul>
          ) : <p className="text-[11px] text-mute">None observed this session.</p>}
          <p className="mt-2 text-[10px] text-mute">Cancellations have many legitimate causes (inventory, hedging, latency). This is a behavioural flag, never an accusation.</p>
        </Card>
      </div>
    </div>
  );
}

function DepthRow({ label, bid, ask }: { label: string; bid: number; ask: number }) {
  const imb = bid + ask > 0 ? (bid - ask) / (bid + ask) : 0;
  return (
    <div>
      <div className="flex justify-between tnum"><span className="text-bull">{fmt.usd(bid)}</span><span className="text-mute">{label}</span><span className="text-bear">{fmt.usd(ask)}</span></div>
      <Meter value={imb} diverging />
    </div>
  );
}

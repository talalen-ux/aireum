"use client";

import { useEffect, useMemo, useState } from "react";
import { useAtlas } from "@/lib/state/store";
import { analyzeCard, FIVE_CARDS, noEdgeExpectancy, REFERENCE_TARGETS, survivalMatrix, type TargetCosts } from "@/lib/risk/conviction";
import { feedQuality, remainingBudget, type Dir, type RiskBudget } from "@/lib/risk/harvest";
import { DETECTOR_LABEL, type DetectorId, type Opportunity } from "@/lib/engine/detectors";
import { REGIME_LABEL } from "@/lib/engine/regime";
import { Badge, Card, cn, fmt, ProvTag, Tabs, Unavailable } from "../ui";

const usd = (v: number | null | undefined) => fmt.usd(v ?? null);
const FAMILY: Record<string, { label: string; detectors: DetectorId[] }> = {
  A: { label: "A · Contrarian forced-flow reversal", detectors: ["liquidation_exhaustion", "passive_absorption", "failed_breakdown", "failed_breakout", "oi_divergence", "price_2b"] },
  B: { label: "B · Directional continuation", detectors: ["short_squeeze", "long_squeeze", "funding_divergence", "spot_perp_divergence", "hidden_accumulation"] },
};

export function ConvictionView() {
  const snap = useAtlas((s) => s.snap);
  const mode = useAtlas((s) => s.mode);
  const asset = useAtlas((s) => s.asset);
  const [tab, setTab] = useState<"cards" | "matrix" | "brief" | "score">("cards");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-semibold">High-Conviction Research</h2>
        <Tabs value={tab} onChange={setTab} items={[{ id: "cards", label: "Forensic card report" }, { id: "matrix", label: "Capital & survival matrix" }, { id: "brief", label: "Opportunity brief" }, { id: "score", label: "Research scorecard" }]} />
        <Badge tone="warn">PAPER — research only, never places orders</Badge>
      </div>
      {tab === "cards" && <Cards />}
      {tab === "matrix" && <Matrix />}
      {tab === "brief" && <Brief />}
      {tab === "score" && <Scorecard />}
      <p className="text-[10px] text-mute">Large profits on shared cards are something to explain, not a performance target. {asset} only: ATLAS has no live feeds for XRP, ZEC or stock-linked perpetuals{mode !== "live" ? `; currently ${mode} data` : ""}.</p>
    </div>
  );
}

// ------------------------------------------------------------------ 3. Forensic card report
function Cards() {
  const rows = useMemo(() => FIVE_CARDS.map(analyzeCard), []);
  const totalMargin = rows.reduce((a, r) => a + (r.nominalMargin ?? 0), 0);
  const totalNotional = rows.reduce((a, r) => a + (r.notional ?? 0), 0);
  return (
    <div className="space-y-3">
      <Card title="What the five cards show, and what they don't" subtitle="Card-reported values, not independently verified · share time ≠ execution time">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] tnum">
          <Kv k="Combined card PNL" v={usd(FIVE_CARDS.reduce((a, c) => a + c.pnl, 0))} />
          <Kv k="Inferred exposure (sum)" v={<span className="text-infer">{usd(totalNotional)}</span>} />
          <Kv k="Inferred initial margin (sum)" v={<span className="text-infer">{usd(totalMargin)}</span>} />
          <Kv k="Losing trades shown" v={<span className="text-warn">none — winners only</span>} />
        </div>
        <p className="mt-2 text-[11px] text-dim">Each six-figure gain corresponds to roughly $60k–$345k of initial margin and $1.2M–$6.9M of exposure. The percentage moves were ordinary (3–6% on four of five); the dollar size came from capital, not from skill that can be read off the card.</p>
      </Card>
      <div className="grid gap-3 lg:grid-cols-2">
        {rows.map((f) => (
          <Card key={f.card.asset} title={`${f.card.asset} · ${f.card.dir.toUpperCase()} ${f.card.leverage}×`} subtitle={`${f.card.venue} · shared ${f.card.shared}`} right={f.possiblyOpen ? <Badge tone="warn">may be unrealized</Badge> : f.basis === "roi_only" ? <Badge tone="warn">weak basis</Badge> : <Badge>closed-price card</Badge>}>
            <h4 className="text-[10px] uppercase tracking-wider text-info mb-1">Visible on the card <ProvTag p="observed" className="ml-1" /></h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] tnum">
              <Kv k="PNL" v={usd(f.card.pnl)} />
              <Kv k="ROI" v={f.card.roiPct !== null ? `${f.card.roiPct}%` : <span className="text-mute">not shown</span>} />
              <Kv k="Entry" v={f.card.entry !== null ? fmt.px(f.card.entry, f.card.entry < 10 ? 4 : 2) : <span className="text-mute">not shown</span>} />
              <Kv k={f.card.refLabel ?? "Exit"} v={f.card.ref !== null ? fmt.px(f.card.ref, f.card.ref < 10 ? 4 : 2) : <span className="text-mute">not shown</span>} />
            </div>
            <h4 className="text-[10px] uppercase tracking-wider text-infer mt-3 mb-1">Inferred under assumptions <ProvTag p="inferred" className="ml-1" /></h4>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] tnum">
              <Kv k="Favorable move" v={f.movePct !== null ? `${f.movePct.toFixed(2)}%` : "—"} />
              <Kv k="Quantity" v={f.quantity !== null ? f.quantity.toLocaleString("en-US", { maximumFractionDigits: 2 }) : <span className="text-mute">unknown</span>} />
              <Kv k="Exposure" v={usd(f.notional)} />
              <Kv k="Initial margin" v={usd(f.nominalMargin)} />
              <Kv k="Adverse room" v={f.adverseRoomPct !== null ? `≈ ${f.adverseRoomPct.toFixed(1)}%` : "—"} hint="1 ÷ leverage: an adverse move of about this size exhausts nominal margin. Not a liquidation price." />
              <Kv k="Margin exhaustion" v={f.marginExhaustion !== null ? fmt.px(f.marginExhaustion, f.marginExhaustion < 10 ? 4 : 2) : "—"} hint="Simplified boundary. The venue's real liquidation price is unknown." />
              <Kv k="ROI check" v={f.roiConsistent === null ? <span className="text-mute">n/a</span> : f.roiConsistent ? <span className="text-bull">reconciles</span> : <span className="text-bear">does not reconcile</span>} />
              <Kv k="Liquidation price" v={<span className="text-mute">unknown</span>} />
            </div>
            <ul className="mt-2 list-disc pl-4 text-[10px] text-dim space-y-0.5">{f.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
            <details className="mt-1 text-[10px] text-mute"><summary className="cursor-pointer">Not knowable from the card ({f.missing.length})</summary>{f.missing.join(" · ")}</details>
          </Card>
        ))}
      </div>
      <Card title="Open research questions">
        <ul className="list-disc pl-4 text-[11px] text-dim space-y-1">
          <li>Would a realistic entry at each price have survived the adverse swings before the move? Needs tick or minute history for those dates on those venues, which is not loaded here.</li>
          <li>Was each move spot-led, futures-led, liquidation-driven or event-driven? ATLAS can answer this live for BTC and ETH, not retroactively for these dates.</li>
          <li>How do the same signals perform on an unbiased sample that includes the losers? Five winners cannot answer that.</li>
        </ul>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ 2. Capital & survival matrix
function Matrix() {
  const snap = useAtlas((s) => s.snap);
  const mode = useAtlas((s) => s.mode);
  const asset = useAtlas((s) => s.asset);
  const [dir, setDir] = useState<Dir>("long");
  const [venue, setVenue] = useState("binance");
  const [target, setTarget] = useState(100_000);
  const [movePct, setMovePct] = useState(5);
  const [entry, setEntry] = useState<number | "">("");
  const [capital, setCapital] = useState<number | "">("");
  const [taker, setTaker] = useState(0.05);
  const [slipBps, setSlipBps] = useState(2);
  const [budget, setBudget] = useState<RiskBudget | null>(null);
  useEffect(() => { try { const b = localStorage.getItem("atlas.riskBudget.v1"); if (b) setBudget(JSON.parse(b)); } catch { /* ignore */ } }, []);
  const bv = budget ? remainingBudget(budget) : null;
  const mark = snap?.price ?? null;
  const E = entry === "" ? mark : entry;
  const costs: TargetCosts = { entryFee: taker / 100, exitFee: taker / 100, slippage: slipBps / 10_000, fundingPerUnit: 0 };
  const depth = snap?.aggDepth ? (dir === "long" ? snap.aggDepth.ask100 : snap.aggDepth.bid100) : null;
  const ageMs = snap?.priceTs ? Date.now() - snap.priceTs : null;
  const fq = feedQuality(mode, mark === null ? null : ageMs, snap?.liveVenues ?? 0);
  const m = useMemo(() => (E ? survivalMatrix({ dir, asset, venue, entry: E, movePct, target, leverages: [3, 5, 10, 20, 50], costs, capitalUsd: capital === "" ? null : capital, remainingBudgetUsd: bv?.known ? bv.remaining : null, depthUsd: depth }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [E, dir, asset, venue, movePct, target, taker, slipBps, capital, bv?.remaining, depth]);

  return (
    <div className="space-y-3">
      <Card title="Scenario" subtitle="A scenario target is not an expected profit · data quality shown at right" right={<Badge tone={fq.quality === "verified" ? "bull" : "warn"}>data: {fq.quality}</Badge>}>
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2 text-[12px]">
          <div className="flex gap-1 col-span-2 md:col-span-1">{(["long", "short"] as const).map((x) => <button key={x} type="button" onClick={() => setDir(x)} className={cn("flex-1 rounded border py-1 cursor-pointer", dir === x ? (x === "long" ? "border-bull text-bull" : "border-bear text-bear") : "border-line text-dim")}>{x}</button>)}</div>
          <label><span className="block text-[10px] text-mute uppercase">Venue</span><select value={venue} onChange={(e) => setVenue(e.target.value)} className="w-full rounded border border-line bg-bg px-2 py-1">{["binance", "bybit", "okx", "mexc", "other"].map((v) => <option key={v}>{v}</option>)}</select></label>
          <F label={`Entry (${mark ? fmt.px(mark, 0) : "n/a"})`} v={entry} set={(x) => setEntry(x || "")} />
          <F label="Favorable move %" v={movePct} set={setMovePct} step={0.5} />
          <F label="Your capital $" v={capital} set={(x) => setCapital(x || "")} />
          <F label="Taker fee %" v={taker} set={setTaker} step={0.01} />
          <F label="Slippage bp" v={slipBps} set={setSlipBps} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-[10px] text-mute uppercase">Scenario target</span>
          {REFERENCE_TARGETS.map((t) => <button key={t} type="button" onClick={() => setTarget(t)} className={cn("rounded border px-2 py-0.5 text-[11px] tnum cursor-pointer", target === t ? "border-info text-info" : "border-line text-dim")}>${t / 1000}k</button>)}
          <div className="w-32"><F label="" v={target} set={setTarget} step={10_000} /></div>
        </div>
      </Card>
      {!m || !E ? <Card title="Matrix"><Unavailable reason="no entry price" /></Card> : !m.req ? <Card title="Matrix"><Unavailable reason="costs exceed the assumed move — no position size reaches this target" /></Card> : (
        <Card title={`To net ${usd(target)} on a ${movePct}% move`} subtitle={`${m.req.qty.toFixed(3)} ${asset} · ${usd(m.req.notional)} exposure · costs ${usd(m.req.costs)} · exit ${fmt.px(m.req.exit)}`} right={<ProvTag p="modeled" />}>
          <p className="mb-2 text-[11px] text-dim">The size and exposure are the same at every leverage. Leverage only changes how much margin you post and how little room you have before a knock-out.</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-[11px] tnum">
              <thead><tr className="text-left text-mute">{["Leverage", "Margin posted", "Adverse room", "Knock-out price", "Target before knock-out (no edge)", "Lost if knocked out", "No-edge expected value", "Fundable", "Within loss budget"].map((h) => <th key={h} className="font-normal pr-2 py-1">{h}</th>)}</tr></thead>
              <tbody>
                {m.rows.map((r) => {
                  const ev = noEdgeExpectancy(r, target);
                  return (
                    <tr key={r.leverage} className="border-t border-line/30 align-top">
                      <td className="py-1">{r.leverage}×</td>
                      <td>{usd(r.nominalMargin)}</td>
                      <td className={(r.adverseRoomPct ?? 99) < movePct ? "text-warn" : ""}>{r.adverseRoomPct?.toFixed(2)}%</td>
                      <td>{fmt.px(r.liqPrice ?? r.marginExhaustion)} <span className="text-mute">{r.liqKnown && r.liqPrice !== null ? "liq est." : "margin exhaustion"}</span></td>
                      <td className={(r.pTargetBeforeKnockout ?? 1) < 0.5 ? "text-bear" : "text-fg"}>{r.pTargetBeforeKnockout !== null ? `${Math.round(r.pTargetBeforeKnockout * 100)}%` : "—"}</td>
                      <td className="text-bear">{usd(-r.lossIfKnockedOut)}</td>
                      <td className={(ev ?? 0) >= 0 ? "text-dim" : "text-bear"}>{usd(ev)}</td>
                      <td>{r.fundable === null ? <span className="text-mute">enter capital</span> : r.fundable ? <span className="text-bull">yes</span> : <span className="text-bear">no</span>}</td>
                      <td>{r.withinBudget === null ? <span className="text-mute">budget unknown</span> : r.withinBudget ? <span className="text-bull">yes</span> : <span className="text-bear">no</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="mt-2 space-y-0.5 text-[10px] text-warn">{[...new Set(m.rows.flatMap((r) => r.flags.map((f) => `${r.leverage}×: ${f}`)))].slice(0, 8).map((f, i) => <li key={i}>⚠ {f}</li>)}</ul>
          <div className="mt-2 grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px] tnum">
            <Kv k="Visible depth ±100bp (entry side)" v={depth !== null ? usd(depth) : <span className="text-mute">no live book</span>} />
            <Kv k="Entry as share of that depth" v={m.rows[0].depthShare !== null ? <span className={m.rows[0].depthShare > 0.25 ? "text-bear" : ""}>{(m.rows[0].depthShare * 100).toFixed(0)}%</span> : "—"} />
            <Kv k="Remaining loss budget" v={bv?.known ? usd(bv.remaining) : <span className="text-mute">unknown — set it in Profit Harvesting</span>} />
          </div>
          <ul className="mt-2 list-disc pl-4 text-[10px] text-mute space-y-0.5">
            <li>&quot;No edge&quot; treats price as a fair game: the chance of reaching the target first is (room to knock-out) ÷ (room + distance to target). A real edge raises it; fees and funding lower it.</li>
            <li>The knock-out price is a venue-tier estimate for Binance, Bybit and OKX on BTC/ETH. For other venues it is the simplified margin-exhaustion boundary, which is not a liquidation price.</li>
            <li>A target reached only after a knock-out counts as a loss. Stops, partial fills and gaps are not modeled in this table; use Trade Lab for path simulation.</li>
          </ul>
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ 1. Trade opportunity brief
function Brief() {
  const snap = useAtlas((s) => s.snap);
  const mode = useAtlas((s) => s.mode);
  if (!snap) return <Card title="Brief"><Unavailable reason="engine not running" /></Card>;
  const ageMs = snap.priceTs ? Date.now() - snap.priceTs : null;
  const fq = feedQuality(mode, snap.price === null ? null : ageMs, snap.liveVenues);
  const side = (s: "long" | "short") => snap.opportunities.filter((o) => o.side === s);
  const none = !snap.opportunities.some((o) => o.state === "developing" || o.state === "actionable");
  const fam = (o: Opportunity) => (FAMILY.A.detectors.includes(o.detector) ? "A" : FAMILY.B.detectors.includes(o.detector) ? "B" : "—");
  return (
    <div className="space-y-3">
      <Card title="Market state" subtitle={`${snap.priceSource ?? "no price"} · ${fmt.time(snap.ts)}`} right={<Badge tone={fq.quality === "verified" ? "bull" : "warn"}>data: {fq.quality}</Badge>}>
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 text-[11px] tnum">
          <Kv k="Price" v={fmt.px(snap.price)} />
          {(["15m", "1h", "4h", "1d"] as const).map((tf) => <Kv key={tf} k={`Regime ${tf}`} v={snap.assessments[tf]?.primary ? REGIME_LABEL[snap.assessments[tf]!.primary!] : "none"} />)}
          <Kv k="Feeds" v={`${snap.liveVenues}/${snap.totalStreams}`} />
        </div>
        <p className="mt-1 text-[10px] text-mute">{fq.note}</p>
      </Card>
      <div className="grid gap-3 lg:grid-cols-3">
        {(["long", "short"] as const).map((s) => (
          <Card key={s} title={`${s === "long" ? "Long" : "Short"} case`} subtitle="Conditional scenarios with their strongest counter-evidence">
            {side(s).length ? side(s).slice(0, 3).map((o) => (
              <div key={o.key} className="mb-2 border-b border-line/30 pb-2 text-[11px]">
                <div className="flex flex-wrap items-center gap-1"><span className="font-medium">{DETECTOR_LABEL[o.detector]}</span><Badge>{o.tf}</Badge><Badge>{o.state}</Badge><Badge tone="info">family {fam(o)}</Badge></div>
                <p className="text-dim">{o.thesis}</p>
                <div className="tnum text-mute">trigger {fmt.px(o.trigger)} · invalidation {fmt.px(o.invalidation)} · evidence {Math.round(o.strength * 100)}/100</div>
                {o.counter[0] && <div className="text-bear/90">Against: {o.counter[0].label} — {o.counter[0].value}</div>}
              </div>
            )) : <p className="text-[11px] text-mute">No {s} hypothesis meets evidence thresholds.</p>}
          </Card>
        ))}
        <Card title="No-trade case" subtitle="Always a valid outcome">
          <p className={cn("text-[12px] font-medium", none ? "text-warn" : "text-dim")}>{none ? "NO TRADE: nothing has progressed beyond first detection." : "At least one hypothesis is developing — still conditional on its trigger and invalidation."}</p>
          <ul className="mt-2 list-disc pl-4 text-[11px] text-dim space-y-1">
            <li>Evidence strength is agreement between measurements, not a probability of profit.</li>
            <li>Size from the remaining loss budget (Profit Harvesting) and check the survival matrix before any leverage choice.</li>
          </ul>
          <div className="mt-2 space-y-1"><Unavailable reason="C · Event-driven: no licensed calendar, earnings or news feed" /><Unavailable reason="D · Relative strength: only BTC and ETH are covered" /></div>
        </Card>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ 4/5. Research scorecard & comparison
function Scorecard() {
  return (
    <div className="space-y-3">
      <Card title="Research scorecard" subtitle="Real daily data, 2015 → May 2026 · holdout 2021–2026 never used for tuning · research/reports/EDGE_SEARCH.md">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-[11px]">
            <thead><tr className="text-left text-mute">{["Family", "Rule tested", "Holdout result (BTC)", "Verdict"].map((h) => <th key={h} className="font-normal pr-2 py-1">{h}</th>)}</tr></thead>
            <tbody className="tnum">
              <tr className="border-t border-line/30"><td>B · Continuation</td><td>Long when 30-day return &gt; 0</td><td>26.5%/yr vs 19.5% hold; worst drawdown −48% vs −77%</td><td className="text-bull">held up (also on ETH)</td></tr>
              <tr className="border-t border-line/30"><td>B · Continuation</td><td>Long when price &gt; 100-day average</td><td>31.4%/yr; drawdown −38%</td><td className="text-bull">held on BTC, weak on ETH</td></tr>
              <tr className="border-t border-line/30"><td>C · Event / cross-asset</td><td>Long 5 days after a VIX 2B top</td><td>−2.7%/yr; up 43% of the time</td><td className="text-bear">did not survive</td></tr>
              <tr className="border-t border-line/30"><td>A · Contrarian reversal</td><td>Exhaustion detector</td><td className="text-mute">not testable: needs intraday order-flow history</td><td className="text-warn">unvalidated</td></tr>
              <tr className="border-t border-line/30"><td>D · Asymmetric movers</td><td>—</td><td className="text-mute">no multi-asset data loaded</td><td className="text-warn">unvalidated</td></tr>
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[10px] text-mute">Unleveraged, daily closes, 0.10% cost per position change. These are not the leveraged trades on the cards: none of the card setups has been reproduced or tested, and expectancy, CVaR, MAE/MFE and liquidation frequency for leveraged entries remain unmeasured until an unbiased intraday sample exists.</p>
      </Card>
      <Card title="How this relates to Profit Harvesting">
        <ul className="list-disc pl-4 text-[11px] text-dim space-y-1">
          <li><b>High-conviction</b> asks whether a large directional position is fundable, executable and likely to survive to its target. The survival matrix answers that before any trade.</li>
          <li><b>Profit Harvesting</b> asks how to take profit once in a trade: scale out of one position, or take repeated fixed-dollar wins. It shows the break-even win rate each needs.</li>
          <li>Both share one cumulative loss budget, and neither creates an edge. Size and leverage change the shape of outcomes, not their average.</li>
        </ul>
      </Card>
    </div>
  );
}

function Kv({ k, v, hint }: { k: string; v: React.ReactNode; hint?: string }) {
  return <div title={hint} className="min-w-0"><div className="text-[10px] text-mute truncate">{k}</div><div className="truncate">{v}</div></div>;
}
function F({ label, v, set, step = 1 }: { label: string; v: number | ""; set: (x: number) => void; step?: number }) {
  return <label className="block min-w-0">{label && <span className="block text-[10px] text-mute uppercase truncate">{label}</span>}<input type="number" step={step} value={v} onChange={(e) => set(Number(e.target.value))} className="w-full min-w-0 rounded border border-line bg-bg px-2 py-1 text-[12px] tnum" /></label>;
}

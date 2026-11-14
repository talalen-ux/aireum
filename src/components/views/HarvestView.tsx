"use client";

import { useEffect, useMemo, useState } from "react";
import { useAtlas } from "@/lib/state/store";
import { applyResult, compareStrategies, feedQuality, liquidationCheck, netUnrealized, planHarvest, planMicro, remainingBudget, sign, type CompareResult, type Costs, type Dir, type LadderMode, type RiskBudget, type StratStats } from "@/lib/risk/harvest";
import { DETECTOR_LABEL } from "@/lib/engine/detectors";
import { Badge, Card, cn, fmt, ProvTag, Tabs, Unavailable } from "../ui";

const BKEY = "atlas.riskBudget.v1";
const VENUES = ["binance", "bybit", "okx", "kucoin", "hyperliquid", "other"] as const;
const usd = (v: number | null | undefined, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`);

function Num({ label, value, onChange, step = 1, suffix, hint }: { label: string; value: number | ""; onChange: (v: number) => void; step?: number; suffix?: string; hint?: string }) {
  return (
    <label className="block min-w-0" title={hint}>
      <span className="text-[10px] text-mute uppercase tracking-wider">{label}</span>
      <div className="flex items-center gap-1">
        <input type="number" inputMode="decimal" step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full min-w-0 rounded border border-line bg-bg px-2 py-1 text-[12px] tnum outline-none focus:border-info/60" />
        {suffix && <span className="text-[10px] text-mute">{suffix}</span>}
      </div>
    </label>
  );
}

export function HarvestView() {
  const snap = useAtlas((s) => s.snap);
  const mode = useAtlas((s) => s.mode);
  const asset = useAtlas((s) => s.asset);
  const [tab, setTab] = useState<"A" | "B" | "compare">("compare");
  const [dir, setDir] = useState<Dir>("long");
  const [venue, setVenue] = useState<(typeof VENUES)[number]>("binance");
  const [entry, setEntry] = useState<number | "">("");
  const [stopPct, setStopPct] = useState(1.0);
  const [leverage, setLeverage] = useState(10);
  const [riskUsd, setRiskUsd] = useState(250);
  const [target, setTarget] = useState(100);
  const [feeKind, setFeeKind] = useState<"taker" | "maker">("taker");
  const [takerPct, setTakerPct] = useState(0.06);
  const [makerPct, setMakerPct] = useState(0.02);
  const [slipBps, setSlipBps] = useState(1);
  const [fundingPerUnit, setFundingPerUnit] = useState(0);
  const [ladderMode, setLadderMode] = useState<LadderMode>("percent");
  const [steps, setSteps] = useState(3);
  const [stepValue, setStepValue] = useState(25);
  const [stepDistPct, setStepDistPct] = useState(0.5);
  const [maxTrades, setMaxTrades] = useState(10);
  const [cooldown, setCooldown] = useState(5);
  const [driftBp, setDriftBp] = useState(0);
  const [horizonH, setHorizonH] = useState(8);
  const [budget, setBudget] = useState<RiskBudget>({ cumulativeLossLimitUsd: null, realizedLossesUsd: 0, otherOpenRiskUsd: 0 });
  const [lastLiquidated, setLastLiquidated] = useState(false);
  const [logVal, setLogVal] = useState<number | "">("");
  const [cmp, setCmp] = useState<CompareResult | null>(null);

  useEffect(() => { try { const b = localStorage.getItem(BKEY); if (b) setBudget(JSON.parse(b)); } catch { /* ignore */ } }, []);
  const saveBudget = (b: RiskBudget) => { setBudget(b); try { localStorage.setItem(BKEY, JSON.stringify(b)); } catch { /* ignore */ } };

  const mark = snap?.price ?? null;
  const E = entry === "" ? mark : entry;
  const d = sign(dir);
  const ageMs = snap?.priceTs ? (mode === "replay" ? snap.ts - snap.priceTs : Date.now() - snap.priceTs) : null;
  const fq = feedQuality(mode, mark === null ? null : ageMs, snap?.liveVenues ?? 0);
  const fee = (feeKind === "taker" ? takerPct : makerPct) / 100;
  const costs: Costs = useMemo(() => ({ entryFee: fee, exitFee: fee, slippage: slipBps / 10_000, fundingPerUnit }), [fee, slipBps, fundingPerUnit]);
  const bv = remainingBudget(budget);

  const obsSlip = useMemo(() => {
    const v = snap?.venues.find((x) => x.venue === venue && x.market === "perp") ?? snap?.venues.find((x) => x.market === "perp" && x.slip1mBuyBps !== null);
    return v ? { bps: dir === "long" ? v.slip1mBuyBps : v.slip1mSellBps, spread: v.spreadBps, venue: v.venue } : null;
  }, [snap, venue, dir]);
  const volPerMin = useMemo(() => {
    const r = snap?.returns1m ?? [];
    if (r.length < 30) return null;
    const m = r.reduce((a, b) => a + b, 0) / r.length;
    return Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1));
  }, [snap?.returns1m]);

  const calc = useMemo(() => {
    if (!E || !(E > 0)) return null;
    const stop = E * (1 - d * stopPct / 100);
    const micro = planMicro({ dir, entry: E, stop, netTargetUsd: target, costs, maxRiskUsd: riskUsd });
    const qty = micro.qty; // identical capital-at-risk: A uses the same size, so a full stop costs the same dollars
    const stepDistance = E * stepDistPct / 100;
    const harvest = planHarvest({ dir, qty, entry: E, stop, costs, mode: ladderMode, steps, stepValue, stepDistance });
    const liq = liquidationCheck({ venue, asset, dir, qty, entry: E, leverage, stop, mark });
    return { stop, micro, qty, harvest, liq, stepDistance };
  }, [E, d, dir, stopPct, target, costs, riskUsd, ladderMode, steps, stepValue, stepDistPct, venue, asset, leverage, mark]);

  const runCompare = () => {
    if (!E || !calc) return;
    const vol = volPerMin ?? 0.0008;
    setCmp(compareStrategies({
      dir, entry: E, stop: calc.stop, costs, riskUsd, netTargetUsd: target, maxTrades, cooldownBars: cooldown,
      harvest: { mode: ladderMode, steps, stepValue, stepDistance: calc.stepDistance },
      volPerBar: vol, driftPerBar: driftBp / 10_000, bars: Math.round(horizonH * 60), paths: 3000, seed: 7, stopGapBps: 2,
      sessionLossLimitUsd: bv.known && bv.remaining !== null ? Math.max(riskUsd, Math.min(bv.remaining, riskUsd * maxTrades)) : undefined,
    }));
  };

  const blocked = bv.known && (bv.exhausted || (bv.remaining !== null && bv.remaining < riskUsd));
  const a15 = snap?.assessments["15m"];
  const topLong = snap?.opportunities.find((o) => o.side === "long");
  const topShort = snap?.opportunities.find((o) => o.side === "short");

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-[13px] font-semibold">Profit Harvesting</h2>
        <Tabs value={tab} onChange={setTab} items={[{ id: "A", label: "A · Core Harvest" }, { id: "B", label: "B · Independent Micro-Profit" }, { id: "compare", label: "Compare A vs B" }]} />
        <Badge tone="warn">PAPER — never routes orders</Badge>
        <Badge tone={fq.quality === "verified" ? "bull" : fq.quality === "degraded" ? "warn" : "bear"}>data: {fq.quality}</Badge>
        <span className="text-[10px] text-mute">{fq.note}</span>
      </div>

      {(blocked || lastLiquidated || !bv.known) && (
        <div className={cn("rounded-lg border p-2.5 text-[11px]", blocked ? "border-bear/60 bg-bear/10 text-bear" : "border-warn/50 bg-warn/10 text-warn")}>
          {blocked && <div><b>Loss-limit guardrail:</b> remaining budget {usd(bv.remaining)} is below the planned risk per attempt ({usd(riskUsd)}). No-trade is the indicated outcome; reduce risk or stand aside.</div>}
          {!bv.known && <div><b>Risk budget unknown:</b> set a cumulative loss limit below. Until then nothing here assumes budget is available.</div>}
          {lastLiquidated && <div><b>Revenge-trading risk:</b> the last attempt ended in liquidation. A liquidation is not a reset — losses carry over. Lower-exposure alternative: half the risk ({usd(riskUsd / 2)}) or stay flat until a fresh, independent signal appears.</div>}
        </div>
      )}

      <div className="grid gap-3 xl:grid-cols-[340px_1fr]">
        {/* -------- inputs */}
        <div className="space-y-3">
          <Card title="Trade inputs" subtitle={`${asset} linear USDT-margined · labeled hypothetical when not live`}>
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-2 flex gap-2">
                {(["long", "short"] as const).map((x) => <button key={x} type="button" onClick={() => setDir(x)} className={cn("flex-1 rounded border py-1 text-[12px] cursor-pointer", dir === x ? (x === "long" ? "border-bull text-bull bg-bull/10" : "border-bear text-bear bg-bear/10") : "border-line text-dim")}>{x.toUpperCase()}</button>)}
              </div>
              <label className="block"><span className="text-[10px] text-mute uppercase tracking-wider">Venue</span>
                <select value={venue} onChange={(e) => setVenue(e.target.value as typeof venue)} className="w-full rounded border border-line bg-bg px-2 py-1 text-[12px]">{VENUES.map((v) => <option key={v}>{v}</option>)}</select>
              </label>
              <Num label="Leverage" value={leverage} onChange={setLeverage} suffix="×" hint="A financing parameter, not a source of edge" />
              <Num label={`Entry (blank = ${mark ? fmt.px(mark) : "n/a"})`} value={entry} onChange={(v) => setEntry(v || "")} />
              <Num label="Stop distance" value={stopPct} onChange={setStopPct} step={0.1} suffix="%" />
              <Num label="Max risk / attempt" value={riskUsd} onChange={setRiskUsd} step={50} suffix="$" hint="Net loss if the stop fills at its trigger" />
              <Num label="Funding / unit" value={fundingPerUnit} onChange={setFundingPerUnit} suffix="$" hint="Expected funding paid (+) per 1 unit over the hold" />
              <div className="col-span-2">
                <span className="text-[10px] text-mute uppercase tracking-wider">Net profit target: <span className="text-fg tnum">${target}</span></span>
                <input type="range" min={10} max={1000} step={10} value={target} onChange={(e) => setTarget(Number(e.target.value))} className="w-full accent-[#31B996]" aria-label="Net profit target" />
              </div>
              <div className="col-span-2"><Tabs value={feeKind} onChange={setFeeKind} items={[{ id: "taker", label: `Taker ${takerPct}%` }, { id: "maker", label: `Maker ${makerPct}%` }]} /></div>
              <Num label="Taker fee" value={takerPct} onChange={setTakerPct} step={0.005} suffix="%" />
              <Num label="Maker fee" value={makerPct} onChange={setMakerPct} step={0.005} suffix="%" />
              <Num label="Exit slippage" value={slipBps} onChange={setSlipBps} step={0.5} suffix="bp" />
              <div className="text-[10px] text-mute self-end">
                {obsSlip?.bps != null ? <>Observed on {obsSlip.venue}: $1M slips {obsSlip.bps.toFixed(1)}bp, spread {obsSlip.spread?.toFixed(2)}bp <button type="button" className="text-info cursor-pointer" onClick={() => setSlipBps(Math.max(0.5, Math.round(obsSlip.bps! * 2) / 2))}>use</button></> : "No live book for a slippage estimate."}
              </div>
            </div>
            <p className="mt-2 text-[10px] text-mute">Fees are assumptions — set them to your account&apos;s tier. Maker fills are not guaranteed; a missed maker exit becomes a taker exit.</p>
          </Card>

          <Card title="Cumulative risk budget" subtitle="Persists across sessions in this browser · losses never reset">
            <div className="grid grid-cols-3 gap-2">
              <Num label="Loss limit" value={budget.cumulativeLossLimitUsd ?? ""} onChange={(v) => saveBudget({ ...budget, cumulativeLossLimitUsd: v > 0 ? v : null })} suffix="$" />
              <Num label="Realized losses" value={budget.realizedLossesUsd ?? 0} onChange={(v) => saveBudget({ ...budget, realizedLossesUsd: Math.max(0, v) })} suffix="$" />
              <Num label="Other open risk" value={budget.otherOpenRiskUsd ?? 0} onChange={(v) => saveBudget({ ...budget, otherOpenRiskUsd: Math.max(0, v) })} suffix="$" />
            </div>
            <div className="mt-2 flex items-baseline justify-between">
              <span className="text-[11px] text-dim">Remaining allowance</span>
              <span className={cn("text-lg font-semibold tnum", !bv.known ? "text-mute" : bv.exhausted ? "text-bear" : "text-fg")}>{bv.known ? usd(bv.remaining) : "unknown"}</span>
            </div>
            {bv.known && budget.cumulativeLossLimitUsd && <div className="h-1.5 rounded bg-elev overflow-hidden"><div className={cn("h-full", bv.exhausted ? "bg-bear" : "bg-bull")} style={{ width: `${Math.max(0, Math.min(100, ((bv.remaining ?? 0) / budget.cumulativeLossLimitUsd) * 100))}%` }} /></div>}
            {bv.note && <p className="mt-1 text-[10px] text-warn">{bv.note}</p>}
            <div className="mt-2 flex items-end gap-2">
              <Num label="Log closed trade net PnL" value={logVal} onChange={(v) => setLogVal(v)} suffix="$" hint="Negative = loss. Wins do not refill the budget." />
              <button type="button" onClick={() => { if (logVal !== "") { saveBudget(applyResult(budget, logVal)); setLogVal(""); } }} className="rounded border border-line bg-elev px-2 py-1 text-[11px] cursor-pointer hover:border-info/60">Log</button>
            </div>
            <label className="mt-2 flex items-center gap-2 text-[11px] text-dim"><input type="checkbox" checked={lastLiquidated} onChange={(e) => setLastLiquidated(e.target.checked)} /> Last attempt ended in liquidation</label>
          </Card>
        </div>

        {/* -------- outputs */}
        <div className="space-y-3 min-w-0">
          {!calc ? <Card title="Plan"><Unavailable reason="no entry price — wait for a feed or type an entry" /></Card> : (
            <>
              <Card title="Venue liquidation buffer" subtitle={calc.liq.known ? "Isolated margin · estimate from transcribed tiers" : "Precise liquidation suppressed"} right={<ProvTag p="modeled" />}>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-[11px] tnum">
                  <Kv k="Size (equal risk)" v={`${calc.qty.toFixed(4)} ${asset}`} />
                  <Kv k="Notional" v={usd(calc.qty * (E ?? 0))} />
                  <Kv k="Stop" v={<span className="text-bear">{fmt.px(calc.stop)}</span>} />
                  <Kv k="Liquidation" v={calc.liq.known ? (calc.liq.liqPrice !== null ? <span className="text-warn">{fmt.px(calc.liq.liqPrice)}</span> : "none") : <span className="text-mute">unknown</span>} />
                  <Kv k="Buffer mark→liq" v={calc.liq.bufferPct !== null ? fmt.pct(calc.liq.bufferPct).replace("+", "") : "—"} />
                </div>
                <p className={cn("mt-1 text-[10px]", calc.liq.stopBeyondLiq ? "text-bear font-semibold" : "text-mute")}>{calc.liq.note} Margin exhaustion E·(1∓1/L) = {fmt.px(calc.liq.exhaustion)} is <b>not</b> a liquidation price.</p>
              </Card>

              {(tab === "A" || tab === "compare") && (
                <Card title="A — Core position + partial profit harvesting" subtitle="Reduce-only scale-outs · the open remainder can erase harvested gains">
                  <div className="mb-2 grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <label className="block"><span className="text-[10px] text-mute uppercase tracking-wider">Ladder</span>
                      <select value={ladderMode} onChange={(e) => { const m = e.target.value as LadderMode; setLadderMode(m); setStepValue(m === "percent" ? 25 : m === "fixed_net_usd" ? target : Number((calc.qty / 4).toFixed(4))); }} className="w-full rounded border border-line bg-bg px-2 py-1 text-[12px]">
                        <option value="percent">% of position per exit</option><option value="fixed_qty">fixed quantity per exit</option><option value="fixed_net_usd">fixed net $ per exit</option>
                      </select>
                    </label>
                    <Num label="Exits" value={steps} onChange={(v) => setSteps(Math.max(1, Math.min(12, Math.round(v))))} />
                    <Num label={ladderMode === "percent" ? "% per exit" : ladderMode === "fixed_qty" ? `${asset} per exit` : "Net $ per exit"} value={stepValue} onChange={setStepValue} step={ladderMode === "fixed_qty" ? 0.001 : 5} />
                    <Num label="Spacing" value={stepDistPct} onChange={setStepDistPct} step={0.1} suffix="%" />
                  </div>
                  <Issues list={calc.harvest.issues} />
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[640px] text-[11px] tnum">
                      <thead><tr className="text-left text-mute">{["#", "Exit price", "Close qty", "Net this exit", "Realized so far", "Remaining", "Exposure", "Combined if remainder stopped", "Gains erased at"].map((h) => <th key={h} className="font-normal pr-2 py-1">{h}</th>)}</tr></thead>
                      <tbody>
                        <tr className="border-t border-line/30 text-dim"><td>0</td><td>{fmt.px(E)} entry</td><td>—</td><td>—</td><td>{usd(0)}</td><td>{calc.qty.toFixed(4)}</td><td>100%</td><td className="text-bear">{usd(-calc.harvest.riskAtEntry)}</td><td>—</td></tr>
                        {calc.harvest.rows.map((r) => (
                          <tr key={r.i} className="border-t border-line/30">
                            <td>{r.i}</td><td>{fmt.px(r.price)}</td><td>{r.qty.toFixed(4)}</td>
                            <td className={r.netUsd > 0 ? "text-bull" : "text-bear"}>{usd(r.netUsd, 2)}</td>
                            <td>{usd(r.cumRealized, 2)}</td><td>{r.remainingQty.toFixed(4)}</td><td>{Math.round(r.exposurePct * 100)}%</td>
                            <td className={r.combinedIfStopped >= 0 ? "text-bull" : "text-bear"}>{usd(r.combinedIfStopped, 2)}</td>
                            <td className="text-warn">{r.giveBackPrice !== null ? fmt.px(r.giveBackPrice) : "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-1 text-[10px] text-mute">Reduce-only coverage: ladder closes {calc.harvest.totalLadderQty.toFixed(4)} of {calc.qty.toFixed(4)} {asset}; residual runner {calc.harvest.residualQty.toFixed(4)} stays exposed to the stop. No automatic re-adds.</div>
                  <CombinedChart dir={dir} E={E!} stop={calc.stop} qty={calc.qty} costs={costs} rows={calc.harvest.rows} mark={mark} />
                </Card>
              )}

              {(tab === "B" || tab === "compare") && (
                <Card title={`B — Independent $${target}-net trades`} subtitle="Close the whole trade at the net target, return to flat, reassess before any new entry">
                  <Issues list={calc.micro.issues} />
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] tnum">
                    <Kv k={`Exit for $${target} net`} v={<span className="text-bull">{fmt.px(calc.micro.exit)}</span>} />
                    <Kv k="Required move" v={calc.micro.requiredMove !== null ? `$${calc.micro.requiredMove.toFixed(2)} (${calc.micro.requiredMoveBps!.toFixed(1)}bp)` : "—"} />
                    <Kv k="Gross needed" v={usd(calc.micro.grossAtExit, 2)} hint="A gross win of this size nets the target. Gross ≠ net." />
                    <Kv k="Costs per round trip" v={<>{usd(calc.micro.costPerRoundTrip, 2)} <span className="text-mute">({calc.micro.costShareOfGross !== null ? Math.round(calc.micro.costShareOfGross * 100) : "—"}% of gross)</span></>} />
                    <Kv k="Net loss at stop" v={<span className="text-bear">{usd(-calc.micro.lossAtStop, 2)}</span>} />
                    <Kv k="Reward : risk" v={calc.micro.rewardRisk !== null ? `1 : ${(1 / calc.micro.rewardRisk).toFixed(2)}` : "—"} />
                    <Kv k="Break-even win rate" v={<span className={cn((calc.micro.breakevenWinRate ?? 0) > 0.7 ? "text-warn" : "")}>{calc.micro.breakevenWinRate !== null ? `${(calc.micro.breakevenWinRate * 100).toFixed(1)}%` : "—"}</span>} hint="L / (T + L). Below this hit rate the strategy loses money however many trades win." />
                    <Kv k="Attempts budget allows" v={bv.known && bv.remaining !== null ? `${Math.max(0, Math.floor(bv.remaining / Math.max(1, calc.micro.lossAtStop)))} losers` : "unknown"} />
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2"><Num label="Daily trade cap" value={maxTrades} onChange={(v) => setMaxTrades(Math.max(1, Math.round(v)))} /><Num label="Cooldown after close" value={cooldown} onChange={(v) => setCooldown(Math.max(0, Math.round(v)))} suffix="min" /></div>
                  <p className="mt-1 text-[10px] text-mute">${target} is an objective, not a guarantee or a reason to trade more. Every re-entry needs a fresh signal from the radar; do not reopen mechanically after a win or a loss.</p>
                </Card>
              )}

              {tab === "compare" && (
                <Card title="Side-by-side at identical capital-at-risk" subtitle="Same simulated price paths · full cost attribution · baseline = same position held without harvesting" right={<ProvTag p="modeled" />}>
                  <div className="flex flex-wrap items-end gap-2 mb-2">
                    <div className="w-28"><Num label="Horizon" value={horizonH} onChange={(v) => setHorizonH(Math.max(1, v))} suffix="h" /></div>
                    <div className="w-40"><Num label="Assumed edge / min" value={driftBp} onChange={setDriftBp} step={0.05} suffix="bp" hint="Drift in your direction. 0 = no edge. Any non-zero value is an assumption, not a measurement." /></div>
                    <button type="button" onClick={runCompare} className="rounded border border-info/50 bg-info/10 px-3 py-1.5 text-[12px] text-info cursor-pointer">Run 3,000 paths</button>
                    <span className="text-[10px] text-mute">Volatility: {volPerMin ? `${(volPerMin * 1e4).toFixed(1)}bp/min from the last ${snap?.returns1m.length} live 1m bars` : "default 8bp/min (no live 1m history yet)"}</span>
                  </div>
                  {cmp ? <CompareTable r={cmp} target={target} /> : <p className="text-[11px] text-mute">Run the simulation to compare expectancy, tail loss, turnover and fees. With edge = 0 both strategies lose the costs on average — that is the baseline any real signal has to beat.</p>}
                </Card>
              )}
            </>
          )}

          <Card title="Evidence panel" subtitle="From the live engine · bull and bear cases side by side" right={<ProvTag p="observed" />}>
            {snap ? (
              <div className="grid gap-3 md:grid-cols-2 text-[11px]">
                <div>
                  <h4 className="text-[10px] uppercase tracking-wider text-bull mb-1">Strongest bull case</h4>
                  {topLong ? <><div className="font-medium">{DETECTOR_LABEL[topLong.detector]} · {topLong.tf} · strength {Math.round(topLong.strength * 100)}/100</div><p className="text-dim">{topLong.thesis}</p><div className="tnum text-mute">invalidation {fmt.px(topLong.invalidation)}</div></> : <p className="text-mute">No long hypothesis meets evidence thresholds.</p>}
                </div>
                <div>
                  <h4 className="text-[10px] uppercase tracking-wider text-bear mb-1">Strongest bear case</h4>
                  {topShort ? <><div className="font-medium">{DETECTOR_LABEL[topShort.detector]} · {topShort.tf} · strength {Math.round(topShort.strength * 100)}/100</div><p className="text-dim">{topShort.thesis}</p><div className="tnum text-mute">invalidation {fmt.px(topShort.invalidation)}</div></> : <p className="text-mute">No short hypothesis meets evidence thresholds.</p>}
                </div>
                <div className="md:col-span-2 grid grid-cols-2 sm:grid-cols-5 gap-2 tnum">
                  <Kv k="Leadership (15m)" v={a15?.leadership ? `${a15.leadership}-led` : "—"} />
                  <Kv k="Spot / perp flow z" v={`${fmt.z(a15?.features?.z.spotFlow)} / ${fmt.z(a15?.features?.z.perpFlow)}`} />
                  <Kv k="Open interest" v={fmt.usd(snap.oiTotalUsd)} />
                  <Kv k="Funding avg" v={snap.fundingAvg8h !== null ? `${(snap.fundingAvg8h * 1e4).toFixed(2)}bp/8h` : "—"} />
                  <Kv k="Liqs 1h L / S" v={`${fmt.usd(snap.liqTotals.long1h)} / ${fmt.usd(snap.liqTotals.short1h)}`} />
                </div>
                <div className="md:col-span-2"><Unavailable reason="macro catalysts: no licensed calendar / news feed connected" /></div>
                {!topLong && !topShort && <p className="md:col-span-2 text-warn">No-trade outcome: neither side currently has sufficient evidence. Planning math above is hypothetical.</p>}
              </div>
            ) : <Unavailable reason="engine not running" />}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Kv({ k, v, hint }: { k: string; v: React.ReactNode; hint?: string }) {
  return <div title={hint} className="min-w-0"><div className="text-[10px] text-mute truncate">{k}</div><div className="truncate">{v}</div></div>;
}

function Issues({ list }: { list: { level: "critical" | "warning"; text: string }[] }) {
  if (!list.length) return null;
  return <ul className="mb-2 space-y-0.5">{list.map((i, k) => <li key={k} className={cn("text-[11px]", i.level === "critical" ? "text-bear" : "text-warn")}>{i.level === "critical" ? "✕" : "⚠"} {i.text}</li>)}</ul>;
}

function CompareTable({ r, target }: { r: CompareResult; target: number }) {
  const rows: [string, (s: StratStats) => string, string?][] = [
    ["Expected net PnL", (s) => usd(s.ev, 0), "Mean over all paths, after all costs"],
    ["Median", (s) => usd(s.median, 0)],
    ["Paths that end positive", (s) => `${Math.round(s.winRate * 100)}%`],
    ["Average winning / losing path", (s) => `${usd(s.avgWin, 0)} / ${usd(s.avgLoss, 0)}`],
    ["Profit factor", (s) => (s.profitFactor !== null ? s.profitFactor.toFixed(2) : "—")],
    ["Worst path", (s) => usd(s.worst, 0)],
    ["CVaR 5% (mean of worst 5%)", (s) => usd(s.cvar5, 0)],
    ["Avg max drawdown", (s) => usd(-s.maxDrawdownAvg, 0)],
    ["Hit the session loss limit", (s) => `${(s.ruinRate * 100).toFixed(1)}%`],
    ["Entries per session", (s) => s.trades.toFixed(1)],
    ["Fees paid", (s) => usd(s.feesAvg, 0)],
    ["Time in market", (s) => `${Math.round(s.timeInMarket * 100)}%`],
  ];
  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-[11px] tnum">
          <thead><tr className="text-left text-mute"><th className="font-normal py-1">Metric</th><th className="font-normal">A · Harvest</th><th className="font-normal">B · ${target} trades</th><th className="font-normal">Baseline · hold</th></tr></thead>
          <tbody>{rows.map(([k, f, hint]) => <tr key={k} className="border-t border-line/30" title={hint}><td className="py-0.5 text-dim">{k}</td><td>{f(r.a)}</td><td>{f(r.b)}</td><td className="text-mute">{f(r.hold)}</td></tr>)}</tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px]">
        B won <b>{r.bTradeWinRate !== null ? Math.round(r.bTradeWinRate * 100) : "—"}%</b> of its individual trades; it needs <b>{r.bBreakeven !== null ? (r.bBreakeven * 100).toFixed(1) : "—"}%</b> to break even.{" "}
        <span className={r.b.ev >= 0 ? "text-bull" : "text-bear"}>{r.b.ev >= 0 ? "Under these assumptions it clears that bar." : "A high hit rate did not produce positive expectancy."}</span>
      </p>
      <ul className="mt-1 list-disc pl-4 text-[10px] text-mute space-y-0.5">{r.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
      <p className="mt-1 text-[10px] text-mute">When each fits: A keeps exposure to a trend while banking part of it, at the cost of give-back risk on the remainder. B caps each win at the target and pays fees on every round trip, so it only works with a measured per-trade edge above its break-even rate. Neither creates edge.</p>
    </div>
  );
}

/** Combined (realized + unrealized) PnL as a function of mark, before any harvest and after the full ladder. */
function CombinedChart({ dir, E, stop, qty, costs, rows, mark }: { dir: Dir; E: number; stop: number; qty: number; costs: Costs; rows: { price: number; cumRealized: number; remainingQty: number; giveBackPrice: number | null }[]; mark: number | null }) {
  const last = rows.at(-1);
  const far = last ? last.price : E + sign(dir) * Math.abs(E - stop);
  const lo = Math.min(stop, far), hi = Math.max(stop, far);
  const pad = (hi - lo) * 0.05;
  const x0 = lo - pad, x1 = hi + pad;
  const N = 60;
  const xs = Array.from({ length: N + 1 }, (_, i) => x0 + ((x1 - x0) * i) / N);
  const before = xs.map((p) => netUnrealized(dir, qty, E, p, costs));
  const after = xs.map((p) => (last ? last.cumRealized + netUnrealized(dir, last.remainingQty, E, p, costs) : NaN));
  const all = [...before, ...after.filter(Number.isFinite), 0];
  const yLo = Math.min(...all), yHi = Math.max(...all);
  const W = 600, H = 150;
  const X = (p: number) => ((p - x0) / (x1 - x0)) * W;
  const Y = (v: number) => H - 6 - ((v - yLo) / Math.max(1e-9, yHi - yLo)) * (H - 12);
  const path = (ys: number[]) => ys.map((v, i) => `${i ? "L" : "M"}${X(xs[i]).toFixed(1)},${Y(v).toFixed(1)}`).join("");
  return (
    <div className="mt-3">
      <div className="text-[10px] text-mute mb-1">Combined PnL (realized + unrealized) vs price — grey: full position, no harvest · teal: after the full ladder. Harvesting flattens the line; it does not remove the downside.</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full h-auto max-h-[220px]" role="img" aria-label="Combined PnL versus price">
        <line x1={0} x2={W} y1={Y(0)} y2={Y(0)} stroke="#243241" />
        <path d={path(before)} fill="none" stroke="#5f6f7f" strokeWidth={1.3} />
        {last && <path d={path(after)} fill="none" stroke="#31B996" strokeWidth={1.6} />}
        <line x1={X(stop)} x2={X(stop)} y1={0} y2={H} stroke="#D66C78" strokeDasharray="3 3" />
        <line x1={X(E)} x2={X(E)} y1={0} y2={H} stroke="#94A3B2" strokeDasharray="1 3" />
        {rows.map((r, i) => <line key={i} x1={X(r.price)} x2={X(r.price)} y1={0} y2={H} stroke="#31B996" strokeOpacity={0.35} />)}
        {last?.giveBackPrice != null && last.giveBackPrice > x0 && last.giveBackPrice < x1 && <circle cx={X(last.giveBackPrice)} cy={Y(0)} r={3.5} fill="#D9AA65" />}
        {mark !== null && mark > x0 && mark < x1 && <line x1={X(mark)} x2={X(mark)} y1={0} y2={H} stroke="#F2F5F7" strokeWidth={0.8} />}
        <text x={X(stop) + 3} y={10} fontSize={9} fill="#D66C78">stop</text>
        <text x={X(E) + 3} y={10} fontSize={9} fill="#94A3B2">entry</text>
        <text x={4} y={Y(yHi) + 9} fontSize={9} fill="#5f6f7f">{usd(yHi)}</text>
        <text x={4} y={Y(yLo) - 2} fontSize={9} fill="#5f6f7f">{usd(yLo)}</text>
      </svg>
      <div className="flex justify-between text-[10px] text-mute tnum"><span>{fmt.px(x0)}</span><span className="text-warn">● price where harvested gains are fully given back</span><span>{fmt.px(x1)}</span></div>
    </div>
  );
}

"use client";

/**
 * Trade Lab — pre-trade position architecture: sizing from max risk, venue-specific liquidation,
 * risk checks and path-dependent Monte Carlo. Everything here is MODELED; simulation is strictly
 * separated from execution (this component never places orders).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Card, Meter, ProvTag, Unavailable, cn, fmt } from "@/components/ui";
import { TIER_TABLE_VERSION, type ContractType, type MarginMode, type PosSide, type RiskVenue } from "@/lib/risk/exchanges";
import { planPosition, type LadderLeg, type PlanInput } from "@/lib/risk/position";
import { runChecks, type Severity } from "@/lib/risk/checks";
import { runMonteCarloChunked, type MCModel, type MCResult } from "@/lib/risk/montecarlo";

export interface TradeLabProps {
  asset: "BTC" | "ETH";
  markPrice: number | null;
  /** Average true range in price units (e.g. 1h ATR). */
  atr?: number | null;
  /** Recent per-minute log returns of the asset, used for vol estimation and bootstrap. */
  returns?: number[];
  /** Book-walk slippage estimator in bps (from live consolidated book). */
  simulateSlippage?: (side: "buy" | "sell", usd: number) => number | null;
  mode: "live" | "simulation" | "replay";
}

type Row = { price: string; pct: string; filled?: boolean };

const num = (s: string) => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : NaN;
};
const round = (v: number, asset: "BTC" | "ETH") => (asset === "BTC" ? Math.round(v) : Math.round(v * 10) / 10);

function LadderEditor({ label, rows, setRows, withFilled, tone }: { label: string; rows: Row[]; setRows: (r: Row[]) => void; withFilled?: boolean; tone: "bull" | "bear" | "dim" }) {
  const upd = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className={cn("text-[10px] font-semibold uppercase tracking-wider", tone === "bull" ? "text-bull" : tone === "bear" ? "text-bear" : "text-dim")}>{label}</span>
        <button type="button" className="text-[10px] text-dim hover:text-fg cursor-pointer" onClick={() => setRows([...rows, { price: rows[rows.length - 1]?.price ?? "", pct: "0" }])}>
          + leg
        </button>
      </div>
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-1">
          <input aria-label={`${label} price ${i + 1}`} inputMode="decimal" className="tnum min-w-0 flex-1 rounded border border-line bg-bg px-1.5 py-1 text-[11px] outline-none focus:border-info" value={r.price} onChange={(e) => upd(i, { price: e.target.value })} />
          <input aria-label={`${label} size % ${i + 1}`} inputMode="decimal" className="tnum w-12 rounded border border-line bg-bg px-1 py-1 text-right text-[11px] outline-none focus:border-info" value={r.pct} onChange={(e) => upd(i, { pct: e.target.value })} />
          <span className="text-[10px] text-mute">%</span>
          {withFilled && (
            <label className="flex items-center gap-0.5 text-[10px] text-mute" title="Already filled">
              <input type="checkbox" checked={!!r.filled} onChange={(e) => upd(i, { filled: e.target.checked })} />F
            </label>
          )}
          <button type="button" aria-label="remove leg" className="px-1 text-[11px] text-mute hover:text-bear cursor-pointer" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] uppercase tracking-wider text-mute">{label}</span>
      {children}
    </label>
  );
}
const inputCls = "tnum w-full min-w-0 rounded border border-line bg-bg px-1.5 py-1 text-[11px] outline-none focus:border-info";

function Seg<T extends string>({ value, options, onChange }: { value: T; options: { v: T; l: string; tone?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded border border-line bg-bg p-0.5">
      {options.map((o) => (
        <button key={o.v} type="button" onClick={() => onChange(o.v)} className={cn("flex-1 rounded px-1.5 py-0.5 text-[11px] font-medium cursor-pointer", value === o.v ? o.tone ?? "bg-elev text-fg" : "text-mute hover:text-dim")}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

const SEV: Record<Severity, { tone: "bear" | "warn" | "dim"; label: string }> = {
  critical: { tone: "bear", label: "CRITICAL" },
  warning: { tone: "warn", label: "WARN" },
  info: { tone: "dim", label: "INFO" },
};

function FanChart({ res, entry, liq, stops, targets }: { res: MCResult; entry: number; liq: number | null; stops: number[]; targets: number[] }) {
  const W = 600, H = 180;
  const all = res.sample.flat();
  const levels = [entry, ...stops, ...targets, ...(liq ? [liq] : [])];
  let lo = Math.min(...all, ...levels), hi = Math.max(...all, ...levels);
  const pad = (hi - lo) * 0.05 || 1;
  lo -= pad; hi += pad;
  const y = (p: number) => H - ((p - lo) / (hi - lo)) * H;
  const maxLen = Math.max(...res.sample.map((p) => p.length));
  const x = (i: number) => (i / Math.max(1, maxLen - 1)) * W;
  const line = (p: number, cls: string, label: string) => (
    <g key={label + p}>
      <line x1={0} x2={W} y1={y(p)} y2={y(p)} className={cls} strokeWidth={1} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />
      <text x={W - 4} y={y(p) - 3} textAnchor="end" className="fill-current text-[10px]" style={{ fontSize: 10 }}>
        {label} {fmt.px(p)}
      </text>
    </g>
  );
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-44 w-full" preserveAspectRatio="none" role="img" aria-label="Simulated price paths with entry, stop, target and liquidation levels">
      {res.sample.map((p, k) => (
        <polyline key={k} points={p.map((v, i) => `${x(i)},${y(v)}`).join(" ")} fill="none" stroke="#6aa3d9" strokeOpacity={0.18} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      ))}
      <g className="text-dim">{line(entry, "stroke-dim", "entry")}</g>
      <g className="text-bear">{stops.map((s) => line(s, "stroke-bear", "stop"))}</g>
      <g className="text-bull">{targets.map((t) => line(t, "stroke-bull", "tgt"))}</g>
      {liq && <g className="text-warn">{line(liq, "stroke-warn", "liq")}</g>}
    </svg>
  );
}

export default function TradeLab({ asset, markPrice, atr = null, returns, simulateSlippage, mode }: TradeLabProps) {
  const [side, setSide] = useState<PosSide>("long");
  const [venue, setVenue] = useState<RiskVenue>("binance");
  const [contract, setContract] = useState<ContractType>("linear");
  const [marginMode, setMarginMode] = useState<MarginMode>("isolated");
  const [leverage, setLeverage] = useState("10");
  const [maxRisk, setMaxRisk] = useState("500");
  const [wallet, setWallet] = useState("10000");
  const [addedMargin, setAddedMargin] = useState("0");
  const [makerFee, setMakerFee] = useState("0.02");
  const [takerFee, setTakerFee] = useState("0.05");
  const [funding, setFunding] = useState("0.01");
  const [fundingInt, setFundingInt] = useState("8");
  const [horizon, setHorizon] = useState("24");
  const [slip, setSlip] = useState("5");
  const [useBook, setUseBook] = useState(true);
  const [entries, setEntries] = useState<Row[]>([]);
  const [stops, setStops] = useState<Row[]>([]);
  const [targets, setTargets] = useState<Row[]>([]);
  const [manualPx, setManualPx] = useState("");
  const [mcModel, setMcModel] = useState<MCModel>("jump");
  const [vol, setVol] = useState("55");
  const [paths, setPaths] = useState("5000");
  const [stopFail, setStopFail] = useState("2");
  const [mc, setMc] = useState<MCResult | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const abort = useRef<AbortController | null>(null);

  const refPx = markPrice ?? (num(manualPx) > 0 ? num(manualPx) : null);
  const ladderSide = useRef<string>("");

  // Seed ladders around the reference price once per asset/side.
  useEffect(() => {
    const key = `${asset}:${side}`;
    if (!refPx || ladderSide.current === key) return;
    ladderSide.current = key;
    const s = side === "long" ? 1 : -1;
    setEntries([{ price: String(round(refPx, asset)), pct: "50", filled: false }, { price: String(round(refPx * (1 - s * 0.006), asset)), pct: "50" }]);
    setStops([{ price: String(round(refPx * (1 - s * 0.025), asset)), pct: "100" }]);
    setTargets([{ price: String(round(refPx * (1 + s * 0.03), asset)), pct: "50" }, { price: String(round(refPx * (1 + s * 0.06), asset)), pct: "50" }]);
    setMc(null);
  }, [refPx, asset, side]);

  useEffect(() => {
    if (returns && returns.length > 60) {
      const m = returns.reduce((a, b) => a + b, 0) / returns.length;
      const sd = Math.sqrt(returns.reduce((a, b) => a + (b - m) ** 2, 0) / (returns.length - 1));
      const ann = sd * Math.sqrt(525_600) * 100;
      if (Number.isFinite(ann) && ann > 0) setVol(ann.toFixed(0));
    }
  }, [returns]);

  useEffect(() => {
    if (asset === "ETH" && contract === "inverse") setContract("linear");
  }, [asset, contract]);

  const toLegs = (rows: Row[], reduceOnly: boolean): LadderLeg[] =>
    rows.map((r) => ({ price: num(r.price), weight: num(r.pct) / 100, filled: r.filled, reduceOnly })).filter((l) => l.price > 0 && l.weight > 0);

  const input: PlanInput | null = useMemo(() => {
    const e = toLegs(entries, false);
    if (!e.length) return null;
    return {
      asset, side, venue, contract, marginMode,
      leverage: Math.max(1, num(leverage) || 1),
      maxRiskUsd: Math.max(0, num(maxRisk) || 0),
      entries: e,
      stops: toLegs(stops, true),
      targets: toLegs(targets, true),
      makerFee: (num(makerFee) || 0) / 100,
      takerFee: (num(takerFee) || 0) / 100,
      entryIsMaker: true,
      fundingRate: (num(funding) || 0) / 100,
      fundingIntervalHours: Math.max(1, num(fundingInt) || 8),
      horizonHours: Math.max(1, num(horizon) || 24),
      stopSlippageBps: Math.max(0, num(slip) || 0),
      addedMargin: Math.max(0, num(addedMargin) || 0),
      walletBalance: Math.max(0, num(wallet) || 0),
      slippage: useBook && simulateSlippage ? simulateSlippage : undefined,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset, side, venue, contract, marginMode, leverage, maxRisk, entries, stops, targets, makerFee, takerFee, funding, fundingInt, horizon, slip, addedMargin, wallet, useBook, simulateSlippage]);

  const plan = useMemo(() => {
    if (!input) return null;
    try {
      return planPosition(input);
    } catch {
      return null;
    }
  }, [input]);
  const checks = useMemo(() => (input && plan ? runChecks(input, plan, { atr, mark: refPx, minAtrBuffer: 1 }) : []), [input, plan, atr, refPx]);

  async function runMC() {
    if (!input || !plan || !refPx || plan.qty <= 0) return;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setProgress(0);
    const scaled = returns && returns.length > 30 ? returns.map((r) => r * Math.sqrt(5)) : undefined; // 1m → 5m step
    const res = await runMonteCarloChunked(
      {
        side, qty: plan.qty, entry: plan.avgEntry, start: refPx, liq: plan.liq.liqPrice,
        margin: plan.initialMargin, stops: input.stops.map((s) => ({ price: s.price, fraction: s.weight })), targets: input.targets.map((t) => ({ price: t.price, fraction: t.weight })),
        takerFee: input.takerFee, makerFee: input.makerFee, entryFeeRate: input.makerFee, fundingRate: input.fundingRate, fundingIntervalHours: input.fundingIntervalHours,
      },
      {
        seed: 7, paths: Math.min(50_000, Math.max(200, num(paths) || 5000)), horizonHours: input.horizonHours, stepsPerHour: 12,
        annualVol: Math.max(0, num(vol) || 0) / 100, model: mcModel === "bootstrap" && !scaled ? "gbm" : mcModel, tDof: 4, jumpsPerDay: 1, jumpMean: 0, jumpStd: 0.025,
        returns: scaled, stopFailProb: Math.max(0, num(stopFail) || 0) / 100, stopSlippageBps: input.stopSlippageBps, samplePaths: 50,
      },
      (f) => setProgress(f),
      ctl.signal,
    );
    if (res) setMc(res);
    setProgress(null);
  }

  const critical = checks.filter((c) => c.severity === "critical").length;
  const liq = plan?.liq.liqPrice ?? null;
  const liqDist = liq && refPx ? (liq - refPx) / refPx : null;

  return (
    <Card
      title="Trade Lab · Position Risk"
      subtitle="Simulation only — never routes orders"
      right={
        <>
          <Badge tone={mode === "live" ? "info" : "warn"}>{mode === "live" ? "LIVE MARK" : mode.toUpperCase()}</Badge>
          <ProvTag p="modeled" />
        </>
      }
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        {/* ── inputs ── */}
        <div className="space-y-2.5">
          {markPrice === null && (
            <div className="space-y-1">
              <Unavailable reason="no live mark price; enter a reference price manually" />
              <Field label="Reference price">
                <input className={inputCls} inputMode="decimal" value={manualPx} onChange={(e) => setManualPx(e.target.value)} placeholder={asset === "BTC" ? "e.g. 65000" : "e.g. 3200"} />
              </Field>
            </div>
          )}
          <Seg value={side} onChange={setSide} options={[{ v: "long", l: "LONG", tone: "bg-bull/20 text-bull" }, { v: "short", l: "SHORT", tone: "bg-bear/20 text-bear" }]} />
          <div className="grid grid-cols-2 gap-1.5">
            <Seg value={venue} onChange={setVenue} options={[{ v: "binance", l: "BIN" }, { v: "bybit", l: "BYB" }, { v: "okx", l: "OKX" }]} />
            <Seg value={marginMode} onChange={setMarginMode} options={[{ v: "isolated", l: "ISO" }, { v: "cross", l: "CROSS" }]} />
          </div>
          {asset === "BTC" && <Seg value={contract} onChange={setContract} options={[{ v: "linear", l: "Linear (USDT)" }, { v: "inverse", l: "Inverse (coin)" }]} />}
          <div className="grid grid-cols-3 gap-1.5">
            <Field label="Leverage ×"><input className={inputCls} value={leverage} onChange={(e) => setLeverage(e.target.value)} inputMode="decimal" /></Field>
            <Field label="Max risk $"><input className={inputCls} value={maxRisk} onChange={(e) => setMaxRisk(e.target.value)} inputMode="decimal" /></Field>
            {marginMode === "cross" ? (
              <Field label="Wallet $"><input className={inputCls} value={wallet} onChange={(e) => setWallet(e.target.value)} inputMode="decimal" /></Field>
            ) : (
              <Field label="+Margin $"><input className={inputCls} value={addedMargin} onChange={(e) => setAddedMargin(e.target.value)} inputMode="decimal" /></Field>
            )}
          </div>
          <LadderEditor label="Entries (F = filled)" rows={entries} setRows={setEntries} withFilled tone="dim" />
          <LadderEditor label="Stop ladder" rows={stops} setRows={setStops} tone="bear" />
          <LadderEditor label="Target ladder" rows={targets} setRows={setTargets} tone="bull" />
          <div className="grid grid-cols-3 gap-1.5">
            <Field label="Maker %"><input className={inputCls} value={makerFee} onChange={(e) => setMakerFee(e.target.value)} /></Field>
            <Field label="Taker %"><input className={inputCls} value={takerFee} onChange={(e) => setTakerFee(e.target.value)} /></Field>
            <Field label="Stop slip bp"><input className={inputCls} value={slip} onChange={(e) => setSlip(e.target.value)} /></Field>
            <Field label="Funding %/int"><input className={inputCls} value={funding} onChange={(e) => setFunding(e.target.value)} /></Field>
            <Field label="Interval h"><input className={inputCls} value={fundingInt} onChange={(e) => setFundingInt(e.target.value)} /></Field>
            <Field label="Horizon h"><input className={inputCls} value={horizon} onChange={(e) => setHorizon(e.target.value)} /></Field>
          </div>
          {simulateSlippage && (
            <label className="flex items-center gap-1.5 text-[11px] text-dim">
              <input type="checkbox" checked={useBook} onChange={(e) => setUseBook(e.target.checked)} />
              Estimate stop slippage by walking the live book
            </label>
          )}
        </div>

        {/* ── outputs ── */}
        <div className="min-w-0 space-y-3">
          {!plan ? (
            <Unavailable reason="add at least one entry leg with a price" />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["Size", `${fmt.num(plan.qty, asset === "BTC" ? 4 : 3)} ${asset}`],
                  ["Notional", fmt.usd(plan.notional)],
                  ["Init. margin", fmt.usd(plan.initialMargin)],
                  ["Avg entry", fmt.px(plan.avgEntry)],
                  ["Liquidation", fmt.px(liq)],
                  ["Bankruptcy", fmt.px(plan.liq.bankruptcyPrice)],
                  ["Liq distance", liqDist === null ? "—" : fmt.pct(liqDist)],
                  ["Δ per $100", `${plan.deltaPer100 >= 0 ? "+" : ""}${fmt.usd(plan.deltaPer100)}`],
                  ["Risk at stop", fmt.usd(plan.riskAtStopUsd)],
                  ["Reward:risk", plan.rewardRisk === null ? "—" : `${plan.rewardRisk.toFixed(2)}R`],
                  ["Funding (horizon)", fmt.usd(plan.fundingCost)],
                  ["Liq shift /$1k", plan.liqShiftPer1000Usd === null ? "—" : fmt.px(plan.liqShiftPer1000Usd)],
                ].map(([k, v]) => (
                  <div key={k} className="rounded border border-line/60 bg-bg/60 px-2 py-1.5">
                    <div className="text-[10px] uppercase tracking-wider text-mute">{k}</div>
                    <div className={cn("tnum text-[13px] font-semibold", k === "Liquidation" ? "text-warn" : "text-fg")}>{v}</div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-mute">
                <span>Tier MMR {(plan.liq.mmr * 100).toFixed(2)}% · max {plan.maxLeverageForNotional}× at this notional</span>
                <span>· liquidation evaluated on MARK price</span>
                <span>· sized by {plan.sizingCappedBy}</span>
              </div>

              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-bear">Stops</div>
                  {plan.stopLegs.map((l, i) => (
                    <div key={i} className="tnum flex justify-between text-[11px]"><span className="text-dim">{fmt.px(l.price)} · {(l.fraction * 100).toFixed(0)}%</span><span className="text-bear">{fmt.usd(l.pnlUsd)}</span></div>
                  ))}
                </div>
                <div>
                  <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-bull">Targets</div>
                  {plan.targetLegs.map((l, i) => (
                    <div key={i} className="tnum flex justify-between text-[11px]"><span className="text-dim">{fmt.px(l.price)} · {(l.fraction * 100).toFixed(0)}%</span><span className={l.pnlUsd >= 0 ? "text-bull" : "text-bear"}>{fmt.usd(l.pnlUsd)} {l.rMultiple !== null && <span className="text-mute">({l.rMultiple.toFixed(2)}R)</span>}</span></div>
                  ))}
                </div>
              </div>

              <div>
                <div className="mb-1 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-dim">
                  Risk checks {critical > 0 ? <Badge tone="bear">{critical} critical</Badge> : checks.length === 0 ? <Badge tone="bull">no issues found</Badge> : null}
                </div>
                <ul className="space-y-1">
                  {checks.map((c, i) => (
                    <li key={i} className="flex gap-2 text-[11px]">
                      <Badge tone={SEV[c.severity].tone} className="shrink-0 self-start">{SEV[c.severity].label}</Badge>
                      <span className="min-w-0"><span className="text-fg">{c.title}.</span> <span className="text-dim">{c.detail}</span></span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded border border-line/60 bg-bg/40 p-2">
                <div className="flex flex-wrap items-end gap-1.5">
                  <Field label="Path model">
                    <select className={inputCls} value={mcModel} onChange={(e) => setMcModel(e.target.value as MCModel)}>
                      <option value="gbm">GBM</option>
                      <option value="jump">GBM + jumps</option>
                      <option value="student_t">Student-t (ν=4)</option>
                      <option value="bootstrap" disabled={!returns || returns.length < 30}>Bootstrap observed</option>
                    </select>
                  </Field>
                  <div className="w-16"><Field label="Vol %/yr"><input className={inputCls} value={vol} onChange={(e) => setVol(e.target.value)} /></Field></div>
                  <div className="w-16"><Field label="Paths"><input className={inputCls} value={paths} onChange={(e) => setPaths(e.target.value)} /></Field></div>
                  <div className="w-16"><Field label="Stop fail %"><input className={inputCls} value={stopFail} onChange={(e) => setStopFail(e.target.value)} /></Field></div>
                  <button type="button" onClick={runMC} disabled={!refPx || plan.qty <= 0 || progress !== null} className="rounded border border-info/50 bg-info/15 px-3 py-1 text-[11px] font-semibold text-info hover:bg-info/25 disabled:opacity-40 cursor-pointer">
                    {progress !== null ? `Running ${(progress * 100).toFixed(0)}%` : "Run path simulation"}
                  </button>
                </div>
                {progress !== null && <div className="mt-2"><Meter value={progress} tone="info" /></div>}
                {mc && (
                  <div className="mt-2 space-y-2">
                    <FanChart res={mc} entry={plan.avgEntry} liq={liq} stops={input!.stops.map((s) => s.price)} targets={input!.targets.map((t) => t.price)} />
                    <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                      {[
                        ["P(liquidation)", fmt.pct(mc.pLiquidation, 1).replace("+", ""), mc.pLiquidation > 0.05 ? "text-bear" : "text-fg"],
                        ["P(liq before T1)", fmt.pct(mc.pLiqBeforeFirstTarget, 1).replace("+", ""), "text-fg"],
                        ["P(liq, then rebound)", fmt.pct(mc.pLiqBeforeRebound, 1).replace("+", ""), mc.pLiqBeforeRebound > 0.02 ? "text-warn" : "text-fg"],
                        ["P(stop hit)", fmt.pct(mc.pStop, 1).replace("+", ""), "text-fg"],
                        ...mc.pTargets.map((p, i) => [`P(target ${i + 1})`, fmt.pct(p, 1).replace("+", ""), "text-bull"]),
                        ["E[PnL] after costs", fmt.usd(mc.expectedPnl), mc.expectedPnl >= 0 ? "text-bull" : "text-bear"],
                        ["PnL p5 / p95", `${fmt.usd(mc.pnlQuantiles.p05)} / ${fmt.usd(mc.pnlQuantiles.p95)}`, "text-fg"],
                        ["MAE p50 / p90", `${(mc.maeQuantiles.p50 * 100).toFixed(2)}% / ${(mc.maeQuantiles.p90 * 100).toFixed(2)}%`, "text-fg"],
                      ].map(([k, v, c]) => (
                        <div key={k} className="rounded bg-card px-2 py-1">
                          <div className="text-[10px] text-mute">{k}</div>
                          <div className={cn("tnum text-[12px] font-semibold", c)}>{v}</div>
                        </div>
                      ))}
                    </div>
                    <details className="text-[10px] text-mute">
                      <summary className="cursor-pointer text-dim">Assumptions ({mc.assumptions.length}) <ProvTag p="modeled" className="ml-1" /></summary>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4">{mc.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
                    </details>
                  </div>
                )}
              </div>
            </>
          )}
          <p className="text-[10px] leading-snug text-mute">
            Modeled estimates, not guarantees. Liquidation formulas and maintenance tiers ({TIER_TABLE_VERSION}) must be cross-checked against the venue's own liquidation estimate before trading. Outcome probabilities depend entirely on the stated path assumptions; no position is risk-free.
          </p>
        </div>
      </div>
    </Card>
  );
}

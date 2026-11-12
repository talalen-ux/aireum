"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Card, ProvTag, Tabs, Unavailable, cn, fmt } from "@/components/ui";
import { DEALER_ASSUMPTIONS, analyzeChain, type DealerAssumption, type GexByStrike, type GexProfile, type OptionsAnalysis, type TermPoint } from "@/lib/options/analytics";
import { DERIBIT_OPTIONS_POLL_MS, fetchDeribitChain } from "@/lib/options/deribit";
import { syntheticChain } from "@/lib/options/synthetic";
import type { ChainResult, OptionAsset } from "@/lib/options/types";

export interface OptionsPanelProps {
  asset: OptionAsset;
  spot: number | null;
  mode: "live" | "simulation" | "replay";
  className?: string;
}

type Horizon = "all" | "30" | "7";

/** Live Deribit chain with 60s polling; never invents values on failure. */
function useLiveChain(asset: OptionAsset, enabled: boolean) {
  const [res, setRes] = useState<ChainResult | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let ctl: AbortController | null = null;
    let alive = true;
    const run = async () => {
      ctl?.abort();
      ctl = new AbortController();
      setLoading(true);
      const r = await fetchDeribitChain(asset, { signal: ctl.signal });
      if (!alive) return;
      setRes((prev) => (r.status === "unavailable" && /aborted/i.test(r.reason) ? prev : r));
      setLoading(false);
    };
    setRes(null);
    run();
    const id = setInterval(run, DERIBIT_OPTIONS_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
      ctl?.abort();
    };
  }, [asset, enabled]);
  return { res, loading };
}

/** Synthetic chain only regenerates when spot moves >1% so the demo is stable. */
function useSimChain(asset: OptionAsset, spot: number | null, enabled: boolean): ChainResult | null {
  const anchor = useRef<{ asset: OptionAsset; spot: number } | null>(null);
  if (enabled && spot !== null && (!anchor.current || anchor.current.asset !== asset || Math.abs(spot / anchor.current.spot - 1) > 0.01)) {
    anchor.current = { asset, spot };
  }
  const a = anchor.current;
  return useMemo(() => (enabled && a ? syntheticChain(a.asset, a.spot, Date.now()) : null), [enabled, a]);
}

export function OptionsPanel({ asset, spot, mode, className }: OptionsPanelProps) {
  const [assumption, setAssumption] = useState<DealerAssumption>("short_calls_long_puts");
  const [horizon, setHorizon] = useState<Horizon>("all");
  const live = useLiveChain(asset, mode === "live");
  const sim = useSimChain(asset, spot, mode === "simulation");
  const chain = mode === "live" ? live.res : mode === "simulation" ? sim : null;

  const analysis = useMemo<OptionsAnalysis | null>(() => {
    if (!chain || chain.status !== "ok") return null;
    const ref = spot ?? chain.underlying;
    return analyzeChain(chain, ref, assumption, chain.asOf, { maxDays: horizon === "all" ? undefined : Number(horizon) });
  }, [chain, spot, assumption, horizon]);

  const right = (
    <>
      {mode === "simulation" && <Badge tone="warn">SIMULATION</Badge>}
      {mode === "live" && chain?.status === "ok" && <Badge tone="info">LIVE · Deribit</Badge>}
      <ProvTag p="modeled" />
    </>
  );

  let body: React.ReactNode;
  if (mode === "replay") body = <Unavailable reason="options chain is not part of recorded replay sessions" />;
  else if (mode === "live" && !chain) body = <p className="text-[11px] text-mute">{live.loading ? "Loading Deribit option chain…" : "Waiting for option chain…"}</p>;
  else if (mode === "simulation" && !chain) body = <Unavailable reason="no reference price yet for the simulated chain" />;
  else if (chain && chain.status === "unavailable") body = <Unavailable reason={chain.reason} />;
  else if (analysis && chain?.status === "ok") body = <Body a={analysis} asOf={chain.asOf} licensing={chain.licensing} assumption={assumption} setAssumption={setAssumption} horizon={horizon} setHorizon={setHorizon} />;

  return (
    <Card title={`Options & Dealer Positioning · ${asset}`} subtitle="Deribit option chain · dealer gamma under explicit assumptions" right={right} className={className}>
      {body}
    </Card>
  );
}

function Body({ a, asOf, licensing, assumption, setAssumption, horizon, setHorizon }: {
  a: OptionsAnalysis;
  asOf: number;
  licensing: string;
  assumption: DealerAssumption;
  setAssumption: (d: DealerAssumption) => void;
  horizon: Horizon;
  setHorizon: (h: Horizon) => void;
}) {
  const spec = DEALER_ASSUMPTIONS[assumption];
  const zg = a.profile.zeroGamma;
  const mp = a.maxPain?.strike ?? null;
  const next = a.expiries.nextMajor ?? a.expiries.events[0] ?? null;
  const front = a.surface.term.find((t) => t.atmIv !== null) ?? null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex min-w-0 items-center gap-1.5 text-[11px] text-dim">
          <span className="shrink-0">Dealer assumption</span>
          <select
            value={assumption}
            onChange={(e) => setAssumption(e.target.value as DealerAssumption)}
            className="min-w-0 max-w-[13rem] truncate rounded border border-line bg-bg px-1.5 py-0.5 text-[11px] text-fg"
          >
            {Object.values(DEALER_ASSUMPTIONS).map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
        </label>
        <Tabs<Horizon> value={horizon} onChange={setHorizon} items={[{ id: "all", label: "All" }, { id: "30", label: "≤30d" }, { id: "7", label: "≤7d" }]} />
        <span className="ml-auto text-[10px] text-mute tnum">as of {fmt.time(asOf)}</span>
      </div>
      <p className="text-[10px] leading-snug text-mute">{spec.description}</p>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Net dealer GEX / 1%" value={spec.signed ? fmt.usd(a.gex.totalGex) : `${fmt.usd(a.gex.totalGex)} gross`} tone={!spec.signed ? undefined : a.gex.totalGex >= 0 ? "bull" : "bear"} hint={spec.signed ? (a.gex.totalGex >= 0 ? "Long gamma: hedging dampens" : "Short gamma: hedging amplifies") : "No direction implied"} />
        <Stat label="Zero-gamma (model)" value={zg !== null ? fmt.px(zg, 0) : "—"} hint={zg !== null ? fmt.pct(zg / a.spot - 1) + " vs spot" : a.profile.zeroGammaNote} />
        <Stat label="Max pain (next major)" value={mp !== null ? fmt.px(mp, 0) : "—"} hint={a.maxPain ? new Date(a.maxPain.expiry).toISOString().slice(0, 10) : "—"} />
        <Stat label="Put/Call OI · Vol" value={`${fmt.num(a.pcr.oiRatio)} · ${fmt.num(a.pcr.volumeRatio)}`} hint="observed" />
        <Stat label="ATM IV (front)" value={front?.atmIv != null ? `${(front.atmIv * 100).toFixed(1)}%` : "—"} hint={front ? `${(front.T * 365).toFixed(1)}d` : undefined} />
        <Stat label="25Δ RR (front)" value={front?.rr25 != null ? `${(front.rr25 * 100).toFixed(1)} vp` : "—"} tone={front?.rr25 == null ? undefined : front.rr25 >= 0 ? "bull" : "bear"} hint={front?.rr25 == null ? undefined : front.rr25 >= 0 ? "calls bid" : "puts bid"} />
        <Stat label="Dealer vanna / +1 vol" value={fmt.usd(a.greeks.dealerVannaUsdPerVolPt)} hint={`hedge flow ${fmt.usd(a.greeks.hedgeFlowPerVolPt)}`} />
        <Stat label="Dealer charm / day" value={fmt.usd(a.greeks.dealerCharmUsdPerDay)} hint={`hedge flow ${fmt.usd(a.greeks.hedgeFlowPerDay)}`} />
      </div>

      <Section title="Dealer GEX by strike (±20% of spot)" prov="modeled">
        <GexBars gex={a.gex} spot={a.spot} zeroGamma={zg} maxPain={mp} />
      </Section>

      <Section title="Modeled total GEX vs hypothetical spot" prov="modeled">
        <GexCurve profile={a.profile} spot={a.spot} signed={spec.signed} />
      </Section>

      <div className="grid gap-3 md:grid-cols-2">
        <Section title="ATM IV term structure" prov="modeled">
          <TermChart term={a.surface.term} />
        </Section>
        <Section title="25Δ risk reversal by expiry" prov="modeled">
          <SkewBars term={a.surface.term} />
        </Section>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Section title="Upcoming expiries" prov="observed">
          {a.expiries.events.length === 0 ? (
            <p className="text-[11px] text-mute">No expiries in horizon.</p>
          ) : (
            <ul className="space-y-1">
              {a.expiries.events.slice(0, 6).map((e) => (
                <li key={e.expiry} className={cn("grid grid-cols-[1fr_auto_auto] items-center gap-2 text-[11px]", e === next && "text-fg")}>
                  <span className="truncate text-dim">
                    {new Date(e.expiry).toISOString().slice(5, 10)} <span className="text-mute">{e.kind}</span>
                    {e.major && <Badge tone="warn" className="ml-1">major</Badge>}
                  </span>
                  <span className="tnum">{fmt.usd(e.notionalUsd)}</span>
                  <span className="tnum text-mute">{e.hoursToExpiry < 48 ? `${e.hoursToExpiry.toFixed(0)}h` : `${(e.hoursToExpiry / 24).toFixed(0)}d`}</span>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Largest OI strikes" prov="observed">
          <div className="grid grid-cols-2 gap-3 text-[11px]">
            <div>
              <p className="mb-1 text-bull">Call OI</p>
              {a.walls.callWalls.map((w) => (
                <p key={w.strike} className="flex justify-between tnum"><span>{fmt.px(w.strike, 0)}</span><span className="text-dim">{fmt.num(w.oi, 0)}</span></p>
              ))}
            </div>
            <div>
              <p className="mb-1 text-bear">Put OI</p>
              {a.walls.putWalls.map((w) => (
                <p key={w.strike} className="flex justify-between tnum"><span>{fmt.px(w.strike, 0)}</span><span className="text-dim">{fmt.num(w.oi, 0)}</span></p>
              ))}
            </div>
          </div>
          <p className="mt-1.5 text-[10px] text-mute">Not guaranteed support/resistance — OI does not reveal who is long or short.</p>
        </Section>
      </div>

      <details className="rounded border border-line/60 bg-bg/40 px-2 py-1.5 text-[10px] text-mute">
        <summary className="cursor-pointer text-dim">Assumptions & disclaimers</summary>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {[...new Set([...a.gex.assumptions, ...a.profile.assumptions, ...a.surface.assumptions, ...a.greeks.assumptions, ...a.expiries.assumptions, ...a.walls.assumptions])].map((s) => (
            <li key={s}>{s}</li>
          ))}
          <li>Max pain, put/call walls and zero-gamma levels are not guaranteed magnets or support.</li>
          <li>{licensing}</li>
        </ul>
      </details>
    </div>
  );
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: "bull" | "bear" }) {
  return (
    <div className="min-w-0 rounded border border-line/60 bg-elev/50 px-2 py-1.5">
      <p className="truncate text-[10px] uppercase tracking-wide text-mute">{label}</p>
      <p className={cn("truncate text-[13px] font-semibold tnum", tone === "bull" && "text-bull", tone === "bear" && "text-bear")}>{value}</p>
      {hint && <p className="truncate text-[10px] text-mute">{hint}</p>}
    </div>
  );
}

function Section({ title, prov, children }: { title: string; prov: "observed" | "modeled"; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center gap-1.5">
        <h4 className="text-[11px] font-medium text-dim">{title}</h4>
        <ProvTag p={prov} />
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- charts (SVG, responsive)

const W = 600;

function GexBars({ gex, spot, zeroGamma, maxPain }: { gex: GexByStrike; spot: number; zeroGamma: number | null; maxPain: number | null }) {
  const H = 170, padL = 4, padR = 4, padT = 14, padB = 16;
  const rows = gex.rows.filter((r) => r.strike >= spot * 0.8 && r.strike <= spot * 1.2);
  if (rows.length < 2) return <Unavailable reason="not enough strikes near spot" />;
  const kMin = rows[0].strike, kMax = rows[rows.length - 1].strike;
  const x = (k: number) => padL + ((k - kMin) / (kMax - kMin)) * (W - padL - padR);
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.netGex)), 1);
  const mid = padT + (H - padT - padB) / 2;
  const y = (v: number) => mid - (v / maxAbs) * ((H - padT - padB) / 2);
  const bw = Math.max(1.5, ((W - padL - padR) / rows.length) * 0.7);
  const marker = (v: number | null, color: string, label: string, dy: number) =>
    v !== null && v >= kMin && v <= kMax ? (
      <g>
        <line x1={x(v)} x2={x(v)} y1={padT - 2} y2={H - padB} stroke={color} strokeDasharray="3 3" strokeWidth={1} />
        <text x={Math.min(W - 60, Math.max(2, x(v) + 3))} y={dy} fill={color} fontSize={10}>{label}</text>
      </g>
    ) : null;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Dealer gamma exposure by strike">
      <line x1={padL} x2={W - padR} y1={mid} y2={mid} stroke="var(--color-line)" />
      {rows.map((r) => (
        <rect key={r.strike} x={x(r.strike) - bw / 2} width={bw} y={Math.min(mid, y(r.netGex))} height={Math.max(0.5, Math.abs(y(r.netGex) - mid))} fill={r.netGex >= 0 ? "var(--color-bull)" : "var(--color-bear)"} opacity={0.85}>
          <title>{`${fmt.px(r.strike, 0)}: net ${fmt.usd(r.netGex)} (calls ${fmt.usd(r.callGex)}, puts ${fmt.usd(r.putGex)}) per 1%`}</title>
        </rect>
      ))}
      {marker(spot, "var(--color-fg)", "spot", 10)}
      {marker(zeroGamma, "var(--color-warn)", "0γ", 22)}
      {marker(maxPain, "var(--color-model)", "max pain", 34)}
      <text x={padL} y={H - 3} fill="var(--color-mute)" fontSize={10}>{fmt.px(kMin, 0)}</text>
      <text x={W - padR} y={H - 3} fill="var(--color-mute)" fontSize={10} textAnchor="end">{fmt.px(kMax, 0)}</text>
      <text x={W - padR} y={padT - 3} fill="var(--color-mute)" fontSize={10} textAnchor="end">±{fmt.usd(maxAbs)}</text>
    </svg>
  );
}

function GexCurve({ profile, spot, signed }: { profile: GexProfile; spot: number; signed: boolean }) {
  const H = 130, pad = 14;
  const pts = profile.points;
  if (pts.length < 2) return <Unavailable reason="no profile" />;
  const sMin = pts[0].spot, sMax = pts[pts.length - 1].spot;
  const gMax = Math.max(...pts.map((p) => p.gex), 0);
  const gMin = Math.min(...pts.map((p) => p.gex), 0);
  const span = gMax - gMin || 1;
  const x = (s: number) => pad + ((s - sMin) / (sMax - sMin)) * (W - 2 * pad);
  const y = (g: number) => pad + ((gMax - g) / span) * (H - 2 * pad);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(p.spot).toFixed(1)},${y(p.gex).toFixed(1)}`).join("");
  const y0 = y(0);
  const area = `${d}L${x(sMax)},${y0}L${x(sMin)},${y0}Z`;
  const zg = profile.zeroGamma;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="Total dealer GEX versus hypothetical spot">
      <defs>
        <clipPath id="gex-above"><rect x={0} y={0} width={W} height={y0} /></clipPath>
        <clipPath id="gex-below"><rect x={0} y={y0} width={W} height={H - y0} /></clipPath>
      </defs>
      <line x1={pad} x2={W - pad} y1={y0} y2={y0} stroke="var(--color-line)" />
      <path d={area} fill={signed ? "var(--color-bull)" : "var(--color-info)"} opacity={0.15} clipPath="url(#gex-above)" />
      <path d={area} fill="var(--color-bear)" opacity={0.15} clipPath="url(#gex-below)" />
      <path d={d} fill="none" stroke={signed ? "var(--color-bull)" : "var(--color-info)"} strokeWidth={1.5} clipPath="url(#gex-above)" />
      <path d={d} fill="none" stroke="var(--color-bear)" strokeWidth={1.5} clipPath="url(#gex-below)" />
      <line x1={x(spot)} x2={x(spot)} y1={pad} y2={H - pad} stroke="var(--color-fg)" strokeDasharray="3 3" />
      <text x={x(spot) + 3} y={pad + 8} fill="var(--color-fg)" fontSize={10}>spot</text>
      {zg !== null && (
        <g>
          <circle cx={x(zg)} cy={y0} r={3.5} fill="var(--color-warn)" />
          <text x={Math.min(W - 80, x(zg) + 5)} y={y0 - 5} fill="var(--color-warn)" fontSize={10}>0γ {fmt.px(zg, 0)}</text>
        </g>
      )}
      <text x={pad} y={H - 2} fill="var(--color-mute)" fontSize={10}>{fmt.px(sMin, 0)}</text>
      <text x={W - pad} y={H - 2} fill="var(--color-mute)" fontSize={10} textAnchor="end">{fmt.px(sMax, 0)}</text>
      <text x={W - pad} y={pad - 3} fill="var(--color-mute)" fontSize={10} textAnchor="end">{fmt.usd(gMax)} / {fmt.usd(gMin)}</text>
    </svg>
  );
}

function TermChart({ term }: { term: TermPoint[] }) {
  const pts = term.filter((t) => t.atmIv !== null) as (TermPoint & { atmIv: number })[];
  if (pts.length < 2) return <Unavailable reason="not enough expiries with IV" />;
  const H = 120, pad = 16;
  const days = pts.map((p) => p.T * 365);
  const xs = days.map((d) => Math.sqrt(d));
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const ivs = pts.map((p) => p.atmIv);
  const lo = Math.min(...ivs) * 0.95, hi = Math.max(...ivs) * 1.05;
  const x = (v: number) => pad + ((v - xMin) / (xMax - xMin || 1)) * (W - 2 * pad);
  const y = (v: number) => pad + ((hi - v) / (hi - lo || 1)) * (H - 2 * pad);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(xs[i]).toFixed(1)},${y(p.atmIv).toFixed(1)}`).join("");
  const inverted = pts[0].atmIv > pts[pts.length - 1].atmIv;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full" role="img" aria-label="ATM implied volatility term structure">
        <path d={d} fill="none" stroke="var(--color-model)" strokeWidth={1.75} />
        {pts.map((p, i) => (
          <circle key={p.expiry} cx={x(xs[i])} cy={y(p.atmIv)} r={2.5} fill="var(--color-model)">
            <title>{`${new Date(p.expiry).toISOString().slice(0, 10)} · ${days[i].toFixed(1)}d · ATM ${(p.atmIv * 100).toFixed(1)}%`}</title>
          </circle>
        ))}
        <text x={pad} y={H - 2} fill="var(--color-mute)" fontSize={10}>{days[0].toFixed(1)}d</text>
        <text x={W - pad} y={H - 2} fill="var(--color-mute)" fontSize={10} textAnchor="end">{days[days.length - 1].toFixed(0)}d</text>
        <text x={pad} y={10} fill="var(--color-mute)" fontSize={10}>{(hi * 100).toFixed(0)}%</text>
        <text x={pad} y={H - 12} fill="var(--color-mute)" fontSize={10}>{(lo * 100).toFixed(0)}%</text>
      </svg>
      <p className="text-[10px] text-mute">{inverted ? "Inverted (front > back): near-term event/stress premium." : "Contango (front < back): no acute near-term stress priced."} x-axis √time.</p>
    </div>
  );
}

function SkewBars({ term }: { term: TermPoint[] }) {
  const pts = term.filter((t) => t.rr25 !== null).slice(0, 8);
  if (!pts.length) return <Unavailable reason="25Δ wings not available" />;
  const maxAbs = Math.max(...pts.map((p) => Math.abs(p.rr25 as number)), 0.005);
  return (
    <ul className="space-y-1">
      {pts.map((p) => {
        const v = p.rr25 as number;
        const w = (Math.abs(v) / maxAbs) * 50;
        return (
          <li key={p.expiry} className="grid grid-cols-[3.2rem_1fr_3.6rem] items-center gap-2 text-[11px]">
            <span className="tnum text-mute">{new Date(p.expiry).toISOString().slice(5, 10)}</span>
            <div className="relative h-2 rounded bg-elev">
              <div className="absolute left-1/2 top-0 h-full w-px bg-line" />
              <div className={cn("absolute top-0 h-full rounded", v >= 0 ? "bg-bull" : "bg-bear")} style={{ left: v >= 0 ? "50%" : `${50 - w}%`, width: `${w}%` }} />
            </div>
            <span className={cn("text-right tnum", v >= 0 ? "text-bull" : "text-bear")}>{(v * 100).toFixed(1)}vp</span>
          </li>
        );
      })}
      <li className="text-[10px] text-mute">Negative = puts richer than calls (downside hedging demand).</li>
    </ul>
  );
}

export default OptionsPanel;

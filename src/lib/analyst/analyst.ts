import type { EngineSnapshot } from "../engine/engine";
import { REGIME_LABEL } from "../engine/regime";
import { DETECTOR_LABEL } from "../engine/detectors";
import { perpDelta, spotDelta } from "../engine/bars";

/**
 * Deterministic market analyst. Every sentence is built from computed, timestamped
 * observations in the engine snapshot. Structure is fixed by the spec:
 * observation → interpretation → strongest counterargument → implications → invalidation → data confidence.
 * When inputs are missing it says so instead of inventing them.
 */
export interface AnalystAnswer {
  question: string;
  asOf: number;
  observation: string[];
  interpretation: string;
  counterargument: string;
  implications: string;
  invalidation: string;
  confidence: { level: "low" | "medium" | "high"; why: string };
  sources: string[];
}

export const QUESTIONS = [
  { id: "forced", q: "Is this forced selling or genuine distribution?" },
  { id: "venue", q: "Which venue leads?" },
  { id: "spotled", q: "Is the move spot-led or leverage-led?" },
  { id: "absorption", q: "Where is absorption happening?" },
  { id: "changed", q: "What changed in the last 15 minutes?" },
  { id: "counterfactual", q: "Counterfactual: enter now vs wait for confirmation?" },
] as const;
export type QuestionId = (typeof QUESTIONS)[number]["id"];

const pct = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`);
const usd = (x: number | null | undefined) => (x === null || x === undefined ? "n/a" : Math.abs(x) >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : `$${(x / 1e3).toFixed(0)}K`);
const z = (x: number | null | undefined) => (x === null || x === undefined ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}σ`);

function confidence(s: EngineSnapshot, extra = 0): AnalystAnswer["confidence"] {
  const c = (s.assessments["15m"]?.dataConfidence ?? 0) * 0.6 + Math.min(1, s.liveVenues / 6) * 0.4 + extra;
  const level = c > 0.7 ? "high" : c > 0.45 ? "medium" : "low";
  return { level, why: `${s.liveVenues}/${s.totalStreams} live streams; history: ${s.history.source}; 15m feature confidence ${Math.round((s.assessments["15m"]?.dataConfidence ?? 0) * 100)}%${s.mode !== "live" ? `; ${s.mode.toUpperCase()} data` : ""}.` };
}

export function answer(id: QuestionId, s: EngineSnapshot): AnalystAnswer {
  const q = QUESTIONS.find((x) => x.id === id)!.q;
  const base = { question: q, asOf: s.ts };
  const a15 = s.assessments["15m"];
  const f = a15?.features;
  switch (id) {
    case "forced": {
      const liq = s.liqTotals;
      const oi = f?.z.oiChg ?? null;
      const longLiqShare = liq.long1h + liq.short1h > 0 ? liq.long1h / (liq.long1h + liq.short1h) : null;
      const forced = (oi !== null && oi < -1) && (longLiqShare ?? 0) > 0.6;
      const distrib = (f?.z.spotFlow ?? 0) < -0.8 && (oi === null || oi > -0.5);
      return {
        ...base,
        observation: [
          `15m OI change ${z(oi)}; observed liquidations last hour: longs ${usd(liq.long1h)}, shorts ${usd(liq.short1h)}.`,
          `Spot flow ${z(f?.z.spotFlow)}, perp flow ${z(f?.z.perpFlow)}, momentum ${z(f?.z.mom)}.`,
          `Exhaustion engine (downside): ${s.exhaustion.long ? `${Math.round(s.exhaustion.long.strength * 100)}/100, ${s.exhaustion.long.state}` : "not evaluable"}.`,
        ],
        interpretation: forced
          ? "The profile matches forced deleveraging: open interest is falling while long liquidations dominate — positions are being closed involuntarily rather than new sellers arriving."
          : distrib
            ? "The profile leans to distribution: spot sellers are net aggressive while open interest is not contracting — supply is coming from holders, not forced closures."
            : "Neither pattern is clear: OI, liquidations and spot flow do not jointly point to forced selling or to spot distribution.",
        counterargument: forced
          ? "Venue liquidation feeds are sampled (Binance throttles to ≤1/s per symbol), so the long-liquidation share could be overstated or understated; OI can also fall from voluntary profit-taking by shorts."
          : "Aggressor-side spot volume is a proxy; large passive sellers (iceberg offers) would not appear as aggressive selling at all.",
        implications: forced ? "Forced flows tend to be finite: once leverage is flushed, downside impact per unit of selling often weakens — watch C2/C3 in the exhaustion engine." : "Distribution can persist for many sessions; mean-reversion entries against it carry more risk than against forced flows.",
        invalidation: forced ? "OI turning back up while price keeps falling (fresh shorts) would reclassify this as active selling, not forced." : "Spot flow flipping net positive with OI flat would invalidate distribution.",
        confidence: confidence(s, longLiqShare === null ? -0.15 : 0),
        sources: ["15m features", "venue liquidation feeds", "exhaustion engine"],
      };
    }
    case "venue": {
      const ll = s.leadLag;
      const top = ll?.scores.slice(0, 3) ?? [];
      const disl = [...s.venues].filter((v) => v.dislocationBps !== null).sort((a, b) => Math.abs(b.dislocationBps!) - Math.abs(a.dislocationBps!)).slice(0, 2);
      return {
        ...base,
        observation: [
          ll ? `Lead scores (xcorr of 1s mid returns, ±5s, ${ll.windowSec}s): ${top.map((t) => `${t.key} ${t.leadScore.toFixed(2)}`).join(", ") || "n/a"}.` : "Lead-lag not yet computed (needs ≥150s of mids).",
          `Largest dislocations vs cross-venue median: ${disl.map((d) => `${d.key} ${d.dislocationBps!.toFixed(1)}bp`).join(", ") || "n/a"}.`,
        ],
        interpretation: ll?.leader ? `${ll.leader} is currently leading price discovery: its mid changes tend to precede other venues' by up to a few seconds.` : "No venue shows a stable lead over the window; price discovery appears shared.",
        counterargument: "Lead-lag at 1s resolution is sensitive to feed latency differences (our receipt time, not matching-engine time) and to tick-size/quote-currency differences (USD vs USDT).",
        implications: ll?.leader ? "Dislocations on the leader are more informative than dislocations on laggards; laggard dislocations tend to revert." : "Treat single-venue dislocations as venue-specific flow unless they persist.",
        invalidation: "The leader changes if its lead score falls below 0.15 or another venue overtakes it over the next window.",
        confidence: confidence(s, ll?.leader ? 0 : -0.1),
        sources: ["lead-lag cross-correlation", "venue mids"],
      };
    }
    case "spotled": {
      const ldr = a15?.leadership ?? null;
      const flow = s.flow;
      const d = flow.length > 60 ? { spot: flow[flow.length - 1].spotCvd - flow[flow.length - 61].spotCvd, perp: flow[flow.length - 1].perpCvd - flow[flow.length - 61].perpCvd } : null;
      return {
        ...base,
        observation: [
          `15m: spot flow ${z(f?.z.spotFlow)}, perp flow ${z(f?.z.perpFlow)}, spot share of volume ${f?.raw.spotShare != null ? `${Math.round(f.raw.spotShare * 100)}%` : "n/a"}, momentum ${z(f?.z.mom)}.`,
          d ? `Last ~60s CVD (all venues, base): spot ${d.spot.toFixed(2)}, perp ${d.perp.toFixed(2)}.` : "Session CVD too short for a 60s comparison.",
          `Basis ${f?.raw.basis != null ? `${f.raw.basis.toFixed(1)}bp` : "n/a"} (${z(f?.z.basis)}), funding ${z(f?.z.funding)}.`,
        ],
        interpretation: ldr === "spot" ? "The move is spot-led: spot aggressors are pushing in the direction of price more than perp aggressors." : ldr === "perp" ? "The move is leverage-led: perp aggressors are driving price while spot participation lags — such moves are more fragile and prone to reversal once funding/basis normalizes." : "Leadership is mixed; neither spot nor perp flow clearly dominates the move.",
        counterargument: "Spot volume on USDT pairs includes stablecoin-margined arbitrage that mirrors perp flow; Coinbase/Kraken USD spot is the cleaner demand signal and is weighted equally here.",
        implications: ldr === "perp" ? "Look for funding/basis stretching and OI rising — the precondition for a squeeze in the opposite direction." : "Spot-led moves are more durable; fades need stronger evidence.",
        invalidation: "Leadership flips if the spot−perp flow z gap reverses sign by more than 0.5σ on the next 15m evaluation.",
        confidence: confidence(s),
        sources: ["15m features", "session CVD", "basis/funding"],
      };
    }
    case "absorption": {
      const imp = s.impact;
      const bp = s.bookPressure;
      const walls = s.walls.slice(0, 3);
      const abs = s.opportunities.find((o) => o.detector === "passive_absorption");
      return {
        ...base,
        observation: [
          imp ? `Impact per $1M net aggressive flow: buys ${imp.buyBpsPer1M?.toFixed(2) ?? "n/a"}bp (n=${imp.nBuy}), sells ${imp.sellBpsPer1M?.toFixed(2) ?? "n/a"}bp (n=${imp.nSell}).` : "Impact tracker not ready.",
          `Replenishment ±25bp (60s): bids ${bp?.bidReplenish != null ? Math.round(bp.bidReplenish * 100) + "%" : "n/a"} adds, asks ${bp?.askReplenish != null ? Math.round(bp.askReplenish * 100) + "%" : "n/a"} adds.`,
          `Largest resting levels: ${walls.map((w) => `${w.side} ${w.price.toFixed(0)} ${usd(w.usd)}`).join("; ") || "n/a"}.`,
        ],
        interpretation: abs
          ? `Passive absorption is detected (${abs.side === "long" ? "bids absorbing selling" : "offers absorbing buying"}) near ${abs.zone ? abs.zone[0].toFixed(0) + "–" + abs.zone[1].toFixed(0) : "current price"}.`
          : imp?.buyBpsPer1M != null && imp.sellBpsPer1M != null
            ? imp.buyBpsPer1M < imp.sellBpsPer1M ? "Buying moves price less than equal selling — offers are absorbing buyers (supply overhead)." : "Selling moves price less than equal buying — bids are absorbing sellers (demand underneath)."
            : "Not enough paired flow/price observations to locate absorption.",
        counterargument: "Hidden/iceberg size is not observable; low impact can also reflect market makers re-quoting quickly with no directional intent.",
        implications: "Absorption is a precondition for reversal, not a trigger — it needs price to stop making progress in the aggressor's direction and then reclaim structure.",
        invalidation: "Absorption fails if price trades through the absorbing level with impact per unit flow rising back above its prior window.",
        confidence: confidence(s, imp && imp.nBuy + imp.nSell > 20 ? 0 : -0.15),
        sources: ["impact tracker", "book churn", "wall tracker"],
      };
    }
    case "changed": {
      const b = s.bars1m.length >= 16 ? s.bars1m : null;
      const now = s.ts;
      const transitions = s.audit.filter((x) => now - x.ts <= 15 * 60_000);
      let obs: string[] = [];
      if (b) {
        const w = b.slice(-15), first = b[b.length - 16];
        const sd = w.reduce((a, x) => a + (spotDelta(x) ?? 0), 0), pd = w.reduce((a, x) => a + (perpDelta(x) ?? 0), 0);
        const oi0 = first.oi, oi1 = b[b.length - 1].oi;
        obs = [
          `Price ${pct(b[b.length - 1].c / first.c - 1)} (${first.c.toFixed(1)} → ${b[b.length - 1].c.toFixed(1)}).`,
          `Net aggressive volume (reference venue): spot ${sd.toFixed(2)}, perp ${pd.toFixed(2)} ${s.asset}.`,
          `OI ${oi0 && oi1 ? pct(oi1 / oi0 - 1) : "n/a"}; liquidations longs ${usd(w.reduce((a, x) => a + x.liqLong * x.c, 0))} / shorts ${usd(w.reduce((a, x) => a + x.liqShort * x.c, 0))}.`,
        ];
      } else obs = ["Fewer than 16 live 1m bars — the 15-minute comparison is not yet available."];
      obs.push(transitions.length ? `Signal transitions: ${transitions.slice(0, 5).map((t) => `${t.key.split(":").slice(0, 2).join(" ")} ${t.from ?? "∅"}→${t.to}`).join("; ")}.` : "No signal lifecycle transitions in 15 minutes.");
      const reg = a15?.primary ? REGIME_LABEL[a15.primary] : "no dominant regime";
      return {
        ...base,
        observation: obs,
        interpretation: `The 15m regime reads "${reg}" with directional pressure ${a15?.directionalPressure?.toFixed(2) ?? "n/a"}.`,
        counterargument: "Fifteen minutes is a short window; most changes at this horizon are noise relative to the 1h/4h regime.",
        implications: `Higher timeframe context: 1h ${s.assessments["1h"]?.primary ? REGIME_LABEL[s.assessments["1h"]!.primary!] : "none"}, 4h ${s.assessments["4h"]?.primary ? REGIME_LABEL[s.assessments["4h"]!.primary!] : "none"}.`,
        invalidation: "n/a — descriptive summary.",
        confidence: confidence(s, b ? 0 : -0.3),
        sources: ["1m bars", "audit log", "regime engine"],
      };
    }
    case "counterfactual": {
      const o = s.opportunities.find((x) => x.trigger !== null && x.invalidation !== null);
      if (!o || !s.price) return { ...base, observation: ["No opportunity with a defined trigger and invalidation is live."], interpretation: "There is no hypothesis to compare entries for.", counterargument: "—", implications: "Waiting is the default when no hypothesis meets evidence thresholds.", invalidation: "—", confidence: confidence(s), sources: ["opportunity radar"] };
      const p = s.price, inv = o.invalidation!, trg = o.trigger!;
      const riskNow = Math.abs(p - inv), riskTrig = Math.abs(trg - inv);
      const tgt = o.targets[0]?.price ?? null;
      const rNow = tgt ? Math.abs(tgt - p) / riskNow : null, rTrig = tgt ? Math.abs(tgt - trg) / riskTrig : null;
      return {
        ...base,
        observation: [
          `${DETECTOR_LABEL[o.detector]} (${o.side}, ${o.tf}), state ${o.state}, strength ${Math.round(o.strength * 100)}/100.`,
          `Price ${p.toFixed(1)}, trigger ${trg.toFixed(1)}, invalidation ${inv.toFixed(1)}${tgt ? `, first target ${tgt.toFixed(1)}` : ""}.`,
          `Risk to invalidation: now ${pct(riskNow / p)} vs at trigger ${pct(riskTrig / p)}. Reward/risk to first target: now ${rNow?.toFixed(2) ?? "n/a"} vs at trigger ${rTrig?.toFixed(2) ?? "n/a"}.`,
        ],
        interpretation: "Entering now buys a tighter invalidation and better R at the cost of acting before the trigger confirms; waiting trades R for evidence.",
        counterargument: "If the hypothesis is wrong, the early entry is stopped more often; if right, confirmed entries can miss fast moves entirely (no fill).",
        implications: "Size the early entry from the invalidation distance (Trade Lab), and decide in advance whether a missed trigger is acceptable.",
        invalidation: `${inv.toFixed(1)} — beyond this the thesis is wrong regardless of entry choice.`,
        confidence: confidence(s, -0.05),
        sources: ["opportunity radar", "liquidation model targets"],
      };
    }
  }
}

/** Compact grounding context for an LLM: only computed values, with timestamps. */
export function groundingContext(s: EngineSnapshot) {
  const tf = (k: keyof EngineSnapshot["assessments"]) => {
    const a = s.assessments[k];
    if (!a) return null;
    return { primary: a.primary, active: a.regimes.filter((r) => (r.score ?? 0) >= 0.5).map((r) => r.id), directionalPressure: a.directionalPressure, fragility: a.liquidityFragility, reversal: a.reversalPotential, crowding: a.crowding, crowdedSide: a.crowdedSide, leadership: a.leadership, confidence: a.dataConfidence, z: a.features?.z };
  };
  return {
    asOf: new Date(s.ts).toISOString(), mode: s.mode, asset: s.asset, price: s.price, priceSource: s.priceSource, change24h: s.change24h,
    feeds: { live: s.liveVenues, total: s.totalStreams, history: s.history },
    regimes: { "5m": tf("5m"), "15m": tf("15m"), "1h": tf("1h"), "4h": tf("4h"), "1d": tf("1d") },
    venues: s.venues.map((v) => ({ key: v.key, state: v.state, mid: v.mid, dislocBps: v.dislocationBps, imb25: v.imb25, oiUsd: v.oiUsd, funding8h: v.funding8h })),
    leadLag: s.leadLag ? { leader: s.leadLag.leader, scores: s.leadLag.scores.slice(0, 5) } : null,
    impact: s.impact, bookPressure: s.bookPressure, aggDepth: s.aggDepth, liqTotals: s.liqTotals,
    modeledLiq: s.liqMap ? { nearestLong: s.liqMap.nearestLongCluster, nearestShort: s.liqMap.nearestShortCluster, note: "MODELED estimate" } : null,
    exhaustion: { long: s.exhaustion.long && { strength: s.exhaustion.long.strength, state: s.exhaustion.long.state, conditions: s.exhaustion.long.conditions.map((c) => ({ id: c.id, met: c.met, detail: c.detail })) }, short: s.exhaustion.short && { strength: s.exhaustion.short.strength, state: s.exhaustion.short.state, conditions: s.exhaustion.short.conditions.map((c) => ({ id: c.id, met: c.met, detail: c.detail })) } },
    opportunities: s.opportunities.slice(0, 6).map((o) => ({ detector: o.detector, side: o.side, tf: o.tf, state: o.state, strength: o.strength, trigger: o.trigger, invalidation: o.invalidation, evidence: o.evidence.map((e) => `${e.label}: ${e.value} [${e.provenance}]`), counter: o.counter.map((e) => `${e.label}: ${e.value}`) })),
    largeTrades: s.largeTrades.slice(0, 8).map((t) => ({ t: new Date(t.ts).toISOString(), venue: t.venue, side: t.side, usd: Math.round(t.usd) })),
  };
}

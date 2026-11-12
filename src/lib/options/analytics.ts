/**
 * Options & dealer positioning analytics.
 *
 * Everything here is either an aggregation of observed open interest / volume
 * (provenance "observed") or a model output under explicit assumptions
 * (provenance "modeled"). Dealer positioning is NEVER observed: public venues do
 * not reveal who is long or short. The dealer sign convention is a user choice.
 *
 * Max pain, put/call walls and zero-gamma levels are NOT guaranteed magnets,
 * support or resistance.
 */
import type { Provenance } from "@/lib/core/types";
import { bsGreeks, yearsBetween } from "./blackscholes";
import type { OptionChain, OptionRow } from "./types";

// ---------------------------------------------------------------- assumptions

export type DealerAssumption = "short_calls_long_puts" | "long_calls_short_puts" | "short_all" | "gross_unsigned";

export interface DealerAssumptionSpec {
  id: DealerAssumption;
  label: string;
  description: string;
  /** Dealer position sign per option type (+1 = dealers long). */
  callSign: 1 | -1;
  putSign: 1 | -1;
  /** false = unsigned gross gamma concentration (no direction implied, no flip level). */
  signed: boolean;
}

export const DEALER_ASSUMPTIONS: Record<DealerAssumption, DealerAssumptionSpec> = {
  short_calls_long_puts: {
    id: "short_calls_long_puts",
    label: "Dealers short calls · long puts",
    description: "Customers net buy calls (upside speculation) and net sell puts (yield/overwriting). Common crypto framing.",
    callSign: -1,
    putSign: 1,
    signed: true,
  },
  long_calls_short_puts: {
    id: "long_calls_short_puts",
    label: "Dealers long calls · short puts",
    description: "Customers overwrite calls and buy protective puts. Equity-index convention (SqueezeMetrics/SpotGamma style).",
    callSign: 1,
    putSign: -1,
    signed: true,
  },
  short_all: {
    id: "short_all",
    label: "Dealers short all options",
    description: "Customers are net buyers of every option; dealers are short gamma everywhere.",
    callSign: -1,
    putSign: -1,
    signed: true,
  },
  gross_unsigned: {
    id: "gross_unsigned",
    label: "Flow-agnostic (gross gamma)",
    description: "No dealer direction assumed. Shows where gamma is concentrated; no flip level is implied.",
    callSign: 1,
    putSign: 1,
    signed: false,
  },
};

export const BASE_ASSUMPTIONS = [
  "Black-76 on the venue forward/underlying with zero rates; mark IV held constant (sticky-strike) across spot scenarios.",
  "Open interest treated as 1 coin per contract (Deribit inverse BTC/ETH options).",
  "Dealer positioning is not observable; sign convention is a user-selected assumption.",
];

// ---------------------------------------------------------------- prepared rows

export interface PreparedRow extends OptionRow {
  T: number; // years to expiry
  F: number; // forward / underlying used for pricing
  iv: number | null; // fraction
}

export function prepareRows(chain: OptionChain, now: number): PreparedRow[] {
  const out: PreparedRow[] = [];
  for (const r of chain.rows) {
    const T = yearsBetween(now, r.expiry);
    if (!(T > 0)) continue;
    const mid = r.bidIv && r.askIv ? (r.bidIv + r.askIv) / 2 : null;
    const iv = r.markIv ?? mid;
    out.push({ ...r, T, F: r.underlyingPrice && r.underlyingPrice > 0 ? r.underlyingPrice : chain.underlying, iv });
  }
  return out;
}

function groupBy<T, K>(xs: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const arr = m.get(k);
    if (arr) arr.push(x);
    else m.set(k, [x]);
  }
  return m;
}

/** Linear interpolation of y at x over points (sorted internally). null when x is outside range. */
export function interp(points: [number, number][], x: number): number | null {
  if (points.length === 0) return null;
  const p = [...points].sort((a, b) => a[0] - b[0]);
  if (x < p[0][0] || x > p[p.length - 1][0]) return null;
  for (let i = 1; i < p.length; i++) {
    if (x <= p[i][0]) {
      const [x0, y0] = p[i - 1];
      const [x1, y1] = p[i];
      return x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return p[p.length - 1][1];
}

// ---------------------------------------------------------------- OI / volume

export interface StrikeAgg {
  strike: number;
  callOi: number;
  putOi: number;
  callVol: number;
  putVol: number;
}

export interface OiByStrike {
  rows: StrikeAgg[];
  provenance: Provenance;
  assumptions: string[];
}

export function oiByStrike(rows: OptionRow[]): OiByStrike {
  const m = new Map<number, StrikeAgg>();
  for (const r of rows) {
    const a = m.get(r.strike) ?? { strike: r.strike, callOi: 0, putOi: 0, callVol: 0, putVol: 0 };
    if (r.type === "C") { a.callOi += r.oi; a.callVol += r.volume; } else { a.putOi += r.oi; a.putVol += r.volume; }
    m.set(r.strike, a);
  }
  return { rows: [...m.values()].sort((a, b) => a.strike - b.strike), provenance: "observed", assumptions: ["Sum of venue-reported OI/volume across expiries, in coin units."] };
}

export interface ExpiryAgg {
  expiry: number;
  callOi: number;
  putOi: number;
  callVol: number;
  putVol: number;
  notionalUsd: number;
}

export interface OiByExpiry {
  rows: ExpiryAgg[];
  provenance: Provenance;
  assumptions: string[];
}

export function oiByExpiry(rows: OptionRow[], spot: number): OiByExpiry {
  const g = groupBy(rows, (r) => r.expiry);
  const out: ExpiryAgg[] = [];
  for (const [expiry, rs] of g) {
    const a: ExpiryAgg = { expiry, callOi: 0, putOi: 0, callVol: 0, putVol: 0, notionalUsd: 0 };
    for (const r of rs) {
      if (r.type === "C") { a.callOi += r.oi; a.callVol += r.volume; } else { a.putOi += r.oi; a.putVol += r.volume; }
    }
    a.notionalUsd = (a.callOi + a.putOi) * spot;
    out.push(a);
  }
  out.sort((a, b) => a.expiry - b.expiry);
  return { rows: out, provenance: "observed", assumptions: ["Notional = OI (coin) × current index price."] };
}

export interface PutCallRatios {
  oiRatio: number | null;
  volumeRatio: number | null;
  callOi: number;
  putOi: number;
  callVol: number;
  putVol: number;
  provenance: Provenance;
  assumptions: string[];
}

export function putCallRatios(rows: OptionRow[]): PutCallRatios {
  let callOi = 0, putOi = 0, callVol = 0, putVol = 0;
  for (const r of rows) {
    if (r.type === "C") { callOi += r.oi; callVol += r.volume; } else { putOi += r.oi; putVol += r.volume; }
  }
  return {
    oiRatio: callOi > 0 ? putOi / callOi : null,
    volumeRatio: callVol > 0 ? putVol / callVol : null,
    callOi, putOi, callVol, putVol,
    provenance: "observed",
    assumptions: ["Put/call ratio = put total ÷ call total; does not reveal whether positions are bought or sold."],
  };
}

// ---------------------------------------------------------------- vol surface

export interface TermPoint {
  expiry: number;
  T: number;
  forward: number;
  atmIv: number | null;
  rr25: number | null; // 25Δ call IV − 25Δ put IV
  bf25: number | null; // (25Δ call + 25Δ put)/2 − ATM
}

export interface VolSurfaceSummary {
  term: TermPoint[];
  provenance: Provenance;
  assumptions: string[];
}

export function volSurface(prepared: PreparedRow[]): VolSurfaceSummary {
  const g = groupBy(prepared, (r) => r.expiry);
  const term: TermPoint[] = [];
  for (const [expiry, rs] of g) {
    const withIv = rs.filter((r) => r.iv !== null && r.iv > 0);
    if (!withIv.length) continue;
    const F = rs[0].F;
    const T = rs[0].T;
    // ATM: average call/put IV per strike, interpolate at the forward.
    const byK = groupBy(withIv, (r) => r.strike);
    const kIv: [number, number][] = [...byK].map(([k, xs]) => [k, xs.reduce((s, x) => s + (x.iv as number), 0) / xs.length]);
    const atmIv = interp(kIv, F);
    // 25Δ: OTM wings only, delta from Black-76 on the forward.
    const callPts: [number, number][] = [];
    const putPts: [number, number][] = [];
    for (const r of withIv) {
      const d = bsGreeks({ S: F, K: r.strike, T, sigma: r.iv as number, type: r.type }).delta;
      if (r.type === "C" && r.strike >= F) callPts.push([d, r.iv as number]);
      if (r.type === "P" && r.strike <= F) putPts.push([d, r.iv as number]);
    }
    const c25 = interp(callPts, 0.25);
    const p25 = interp(putPts, -0.25);
    term.push({
      expiry, T, forward: F, atmIv,
      rr25: c25 !== null && p25 !== null ? c25 - p25 : null,
      bf25: c25 !== null && p25 !== null && atmIv !== null ? (c25 + p25) / 2 - atmIv : null,
    });
  }
  term.sort((a, b) => a.expiry - b.expiry);
  return {
    term,
    provenance: "modeled",
    assumptions: [
      "ATM IV linearly interpolated in strike at each expiry's forward.",
      "25Δ wing IVs interpolated in Black-76 forward delta using OTM options only.",
      "Negative risk reversal = puts bid over calls (downside demand); positive = upside demand.",
    ],
  };
}

// ---------------------------------------------------------------- max pain

export interface MaxPain {
  expiry: number;
  strike: number | null;
  /** Total intrinsic payout to option holders (USD) at each candidate settlement strike. */
  curve: { strike: number; payoutUsd: number }[];
  provenance: Provenance;
  assumptions: string[];
}

export function maxPain(rows: OptionRow[], expiry: number): MaxPain {
  const rs = rows.filter((r) => r.expiry === expiry);
  const strikes = [...new Set(rs.map((r) => r.strike))].sort((a, b) => a - b);
  const curve = strikes.map((K) => {
    let pay = 0;
    for (const r of rs) pay += r.oi * (r.type === "C" ? Math.max(K - r.strike, 0) : Math.max(r.strike - K, 0));
    return { strike: K, payoutUsd: pay };
  });
  let best: { strike: number; payoutUsd: number } | null = null;
  for (const c of curve) if (!best || c.payoutUsd < best.payoutUsd) best = c;
  return {
    expiry,
    strike: best?.strike ?? null,
    curve,
    provenance: "modeled",
    assumptions: ["Settlement price that minimises total intrinsic value paid to option holders.", "Max pain is NOT a guaranteed magnet for price."],
  };
}

// ---------------------------------------------------------------- dealer gamma

function dealerSign(spec: DealerAssumptionSpec, type: "C" | "P") {
  return type === "C" ? spec.callSign : spec.putSign;
}

/** Dealer GEX (USD per 1% spot move) of one row evaluated at hypothetical spot `S`. */
function rowGex(r: PreparedRow, S: number, spot: number, spec: DealerAssumptionSpec) {
  if (r.iv === null || r.oi <= 0) return 0;
  const F = r.F * (S / spot);
  const g = bsGreeks({ S: F, K: r.strike, T: r.T, sigma: r.iv, type: r.type }).gamma;
  return dealerSign(spec, r.type) * g * r.oi * S * S * 0.01;
}

export interface GexByStrike {
  rows: { strike: number; callGex: number; putGex: number; netGex: number }[];
  totalGex: number;
  assumption: DealerAssumption;
  provenance: Provenance;
  assumptions: string[];
}

export function gexByStrike(prepared: PreparedRow[], spot: number, assumption: DealerAssumption): GexByStrike {
  const spec = DEALER_ASSUMPTIONS[assumption];
  const m = new Map<number, { strike: number; callGex: number; putGex: number; netGex: number }>();
  let total = 0;
  for (const r of prepared) {
    const v = rowGex(r, spot, spot, spec);
    const a = m.get(r.strike) ?? { strike: r.strike, callGex: 0, putGex: 0, netGex: 0 };
    if (r.type === "C") a.callGex += v; else a.putGex += v;
    a.netGex += v;
    total += v;
    m.set(r.strike, a);
  }
  return {
    rows: [...m.values()].sort((a, b) => a.strike - b.strike),
    totalGex: total,
    assumption,
    provenance: "modeled",
    assumptions: [
      ...BASE_ASSUMPTIONS,
      `Dealer sign: ${spec.label}.`,
      "GEX = sign × Γ × OI × S² × 1% (USD of delta to re-hedge per 1% spot move). Positive = dealers long gamma (hedging dampens moves); negative = short gamma (hedging can amplify moves).",
    ],
  };
}

export interface GexProfile {
  points: { spot: number; gex: number }[];
  zeroGamma: number | null;
  zeroGammaNote: string;
  assumption: DealerAssumption;
  provenance: Provenance;
  assumptions: string[];
}

export function totalGexAt(prepared: PreparedRow[], S: number, spot: number, spec: DealerAssumptionSpec) {
  let t = 0;
  for (const r of prepared) t += rowGex(r, S, spot, spec);
  return t;
}

/** Total dealer GEX across a ±range sweep of hypothetical spot and the zero-gamma flip nearest spot. */
export function gexProfile(prepared: PreparedRow[], spot: number, assumption: DealerAssumption, range = 0.15, steps = 61): GexProfile {
  const spec = DEALER_ASSUMPTIONS[assumption];
  const points: { spot: number; gex: number }[] = [];
  for (let i = 0; i < steps; i++) {
    const S = spot * (1 - range + (2 * range * i) / (steps - 1));
    points.push({ spot: S, gex: totalGexAt(prepared, S, spot, spec) });
  }
  const base = {
    points,
    assumption,
    provenance: "modeled" as Provenance,
    assumptions: [...BASE_ASSUMPTIONS, `Dealer sign: ${spec.label}.`, "Zero-gamma is a model artefact of the assumptions above, not observed support/resistance."],
  };
  if (!spec.signed) return { ...base, zeroGamma: null, zeroGammaNote: "No flip level under a flow-agnostic (unsigned) assumption." };

  let best: number | null = null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a.gex === 0) { if (best === null || Math.abs(a.spot - spot) < Math.abs(best - spot)) best = a.spot; continue; }
    if (Math.sign(a.gex) === Math.sign(b.gex)) continue;
    let lo = a.spot, hi = b.spot, flo = a.gex;
    for (let k = 0; k < 60; k++) {
      const mid = 0.5 * (lo + hi);
      const fm = totalGexAt(prepared, mid, spot, spec);
      if (Math.sign(fm) === Math.sign(flo)) { lo = mid; flo = fm; } else hi = mid;
      if (hi - lo < spot * 1e-7) break;
    }
    const root = 0.5 * (lo + hi);
    if (best === null || Math.abs(root - spot) < Math.abs(best - spot)) best = root;
  }
  return {
    ...base,
    zeroGamma: best,
    zeroGammaNote: best === null ? `No sign change within ±${Math.round(range * 100)}% of spot.` : "Nearest sign change of modeled total dealer GEX.",
  };
}

// ---------------------------------------------------------------- vanna / charm

export interface VannaCharm {
  /** Change in aggregate dealer delta (USD) for a +1 vol-point move in IV. */
  dealerVannaUsdPerVolPt: number;
  /** Change in aggregate dealer delta (USD) per calendar day passing. */
  dealerCharmUsdPerDay: number;
  /** Implied dealer hedge flow (USD, opposite sign) for the same shocks. */
  hedgeFlowPerVolPt: number;
  hedgeFlowPerDay: number;
  assumption: DealerAssumption;
  provenance: Provenance;
  assumptions: string[];
}

export function vannaCharm(prepared: PreparedRow[], spot: number, assumption: DealerAssumption): VannaCharm {
  const spec = DEALER_ASSUMPTIONS[assumption];
  let vanna = 0, charm = 0;
  for (const r of prepared) {
    if (r.iv === null || r.oi <= 0) continue;
    const g = bsGreeks({ S: r.F, K: r.strike, T: r.T, sigma: r.iv, type: r.type });
    const s = dealerSign(spec, r.type);
    vanna += s * g.vanna * r.oi * spot * 0.01;
    charm += s * (g.charm / 365) * r.oi * spot;
  }
  return {
    dealerVannaUsdPerVolPt: vanna,
    dealerCharmUsdPerDay: charm,
    hedgeFlowPerVolPt: -vanna,
    hedgeFlowPerDay: -charm,
    assumption,
    provenance: "modeled",
    assumptions: [
      ...BASE_ASSUMPTIONS,
      `Dealer sign: ${spec.label}.`,
      "Hedge flow assumes dealers keep delta-neutral; positive = dealers would buy underlying.",
      ...(spec.signed ? [] : ["Unsigned assumption: magnitudes only, direction is meaningless."]),
    ],
  };
}

// ---------------------------------------------------------------- walls & expiries

export interface Walls {
  callWalls: { strike: number; oi: number }[];
  putWalls: { strike: number; oi: number }[];
  provenance: Provenance;
  assumptions: string[];
}

export function walls(rows: OptionRow[], n = 3): Walls {
  const agg = oiByStrike(rows).rows;
  return {
    callWalls: [...agg].sort((a, b) => b.callOi - a.callOi).slice(0, n).filter((x) => x.callOi > 0).map((x) => ({ strike: x.strike, oi: x.callOi })),
    putWalls: [...agg].sort((a, b) => b.putOi - a.putOi).slice(0, n).filter((x) => x.putOi > 0).map((x) => ({ strike: x.strike, oi: x.putOi })),
    provenance: "observed",
    assumptions: ["Strikes with the largest open interest by side.", "Walls are NOT guaranteed support or resistance; OI does not reveal who is long."],
  };
}

function lastFridayOfMonth(y: number, m: number) {
  const d = new Date(Date.UTC(y, m + 1, 0));
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() - 1);
  return d.getUTCDate();
}

export type ExpiryKind = "daily" | "weekly" | "monthly" | "quarterly";

export function classifyExpiry(expiry: number): ExpiryKind {
  const d = new Date(expiry);
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (d.getUTCDay() !== 5) return "daily";
  if (d.getUTCDate() === lastFridayOfMonth(y, m)) return m % 3 === 2 ? "quarterly" : "monthly";
  return "weekly";
}

export interface ExpiryEvent {
  expiry: number;
  kind: ExpiryKind;
  hoursToExpiry: number;
  callOi: number;
  putOi: number;
  notionalUsd: number;
  shareOfTotal: number;
  pcr: number | null;
  maxPain: number | null;
  major: boolean;
}

export interface ExpiryEvents {
  events: ExpiryEvent[];
  nextMajor: ExpiryEvent | null;
  provenance: Provenance;
  assumptions: string[];
}

export function expiryEvents(rows: OptionRow[], spot: number, now: number, horizonDays = 45): ExpiryEvents {
  const byExp = oiByExpiry(rows, spot).rows;
  const total = byExp.reduce((s, e) => s + e.notionalUsd, 0);
  const events: ExpiryEvent[] = byExp
    .filter((e) => e.expiry > now && e.expiry - now <= horizonDays * 86_400_000)
    .map((e) => {
      const kind = classifyExpiry(e.expiry);
      const share = total > 0 ? e.notionalUsd / total : 0;
      return {
        expiry: e.expiry,
        kind,
        hoursToExpiry: (e.expiry - now) / 3_600_000,
        callOi: e.callOi,
        putOi: e.putOi,
        notionalUsd: e.notionalUsd,
        shareOfTotal: share,
        pcr: e.callOi > 0 ? e.putOi / e.callOi : null,
        maxPain: maxPain(rows, e.expiry).strike,
        major: kind === "monthly" || kind === "quarterly" || share >= 0.1,
      };
    });
  return {
    events,
    nextMajor: events.find((e) => e.major) ?? null,
    provenance: "modeled",
    assumptions: ["Major = monthly/quarterly expiry or ≥10% of total OI notional.", "Notional at current index price; max pain is not a guaranteed magnet."],
  };
}

// ---------------------------------------------------------------- top-level

export interface OptionsAnalysis {
  asOf: number;
  spot: number;
  assumption: DealerAssumption;
  pcr: PutCallRatios;
  byStrike: OiByStrike;
  byExpiry: OiByExpiry;
  surface: VolSurfaceSummary;
  gex: GexByStrike;
  profile: GexProfile;
  greeks: VannaCharm;
  walls: Walls;
  expiries: ExpiryEvents;
  /** Max pain of the next major expiry (or nearest expiry). */
  maxPain: MaxPain | null;
  provenance: Provenance;
  assumptions: string[];
}

export interface AnalyzeOptions {
  /** Include only expiries within this many days (default: all). */
  maxDays?: number;
  profileRange?: number;
}

export function analyzeChain(chain: OptionChain, spot: number, assumption: DealerAssumption, now: number, opts: AnalyzeOptions = {}): OptionsAnalysis {
  let prepared = prepareRows(chain, now);
  if (opts.maxDays !== undefined) prepared = prepared.filter((r) => r.T * 365 <= (opts.maxDays as number));
  const rows: OptionRow[] = prepared;
  const expiries = expiryEvents(rows, spot, now);
  const mpExpiry = expiries.nextMajor?.expiry ?? expiries.events[0]?.expiry ?? null;
  return {
    asOf: chain.asOf,
    spot,
    assumption,
    pcr: putCallRatios(rows),
    byStrike: oiByStrike(rows),
    byExpiry: oiByExpiry(rows, spot),
    surface: volSurface(prepared),
    gex: gexByStrike(prepared, spot, assumption),
    profile: gexProfile(prepared, spot, assumption, opts.profileRange ?? 0.15),
    greeks: vannaCharm(prepared, spot, assumption),
    walls: walls(rows),
    expiries,
    maxPain: mpExpiry !== null ? maxPain(rows, mpExpiry) : null,
    provenance: "modeled",
    assumptions: [...BASE_ASSUMPTIONS, `Dealer sign: ${DEALER_ASSUMPTIONS[assumption].label}.`],
  };
}

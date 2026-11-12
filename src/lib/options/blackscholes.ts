/**
 * Black-Scholes (Black-76 when `r = 0` and `S` is the forward) pricing and greeks.
 *
 * Conventions:
 *  - `T` in years, `sigma` as a fraction (0.55 = 55% vol), `r` continuously compounded.
 *  - Prices are in quote currency (USD) per 1 unit of underlying.
 *  - vega: price change per 1.00 change in vol (divide by 100 for per vol-point).
 *  - theta: price change per YEAR of calendar time passing (divide by 365 for per day).
 *  - vanna: d(delta)/d(sigma) = d(vega)/dS.
 *  - charm: d(delta)/dt — delta drift per YEAR of calendar time passing (i.e. -d(delta)/dT).
 *
 * Deribit options are INVERSE: premium is quoted and settled in the underlying coin.
 * Use `toInversePremium` / `fromInversePremium` to convert between USD and coin premium.
 */
import { normCdf, normPdf } from "@/lib/core/stats";

export type OptType = "C" | "P";

export interface BsInput {
  S: number;
  K: number;
  T: number;
  sigma: number;
  r?: number;
  type: OptType;
}

export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  vanna: number;
  charm: number;
}

const MIN_T = 1 / (365 * 24 * 60); // one minute floor to avoid singularities at expiry

function d1d2(S: number, K: number, T: number, sigma: number, r: number) {
  const t = Math.max(T, MIN_T);
  const sq = sigma * Math.sqrt(t);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * t) / sq;
  return { d1, d2: d1 - sq, t, sq };
}

export function bsPrice({ S, K, T, sigma, r = 0, type }: BsInput): number {
  if (!(S > 0 && K > 0)) return NaN;
  if (T <= 0 || sigma <= 0) return Math.max(0, type === "C" ? S - K : K - S);
  const { d1, d2, t } = d1d2(S, K, T, sigma, r);
  const df = Math.exp(-r * t);
  return type === "C" ? S * normCdf(d1) - K * df * normCdf(d2) : K * df * normCdf(-d2) - S * normCdf(-d1);
}

export function bsGreeks(inp: BsInput): Greeks {
  const { S, K, T, sigma, r = 0, type } = inp;
  const price = bsPrice(inp);
  if (!(S > 0 && K > 0 && sigma > 0) || T <= 0) {
    const itm = type === "C" ? S > K : S < K;
    return { price, delta: itm ? (type === "C" ? 1 : -1) : 0, gamma: 0, vega: 0, theta: 0, vanna: 0, charm: 0 };
  }
  const { d1, d2, t, sq } = d1d2(S, K, T, sigma, r);
  const nd1 = normPdf(d1);
  const df = Math.exp(-r * t);
  const sqrtT = Math.sqrt(t);
  const delta = type === "C" ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = nd1 / (S * sq);
  const vega = S * nd1 * sqrtT;
  const thetaCommon = (-S * nd1 * sigma) / (2 * sqrtT);
  const theta = type === "C" ? thetaCommon - r * K * df * normCdf(d2) : thetaCommon + r * K * df * normCdf(-d2);
  const vanna = (-nd1 * d2) / sigma;
  // Same for calls and puts when the dividend yield is zero.
  const charm = -nd1 * ((2 * r * t - d2 * sq) / (2 * t * sq));
  return { price, delta, gamma, vega, theta, vanna, charm };
}

/**
 * Implied volatility solver: Newton-Raphson on vega with a bracketing bisection fallback.
 * Returns null when the price violates no-arbitrage bounds or does not converge.
 */
export function impliedVol(price: number, S: number, K: number, T: number, type: OptType, r = 0): number | null {
  if (!(price > 0 && S > 0 && K > 0 && T > 0)) return null;
  const df = Math.exp(-r * T);
  const intrinsic = Math.max(0, type === "C" ? S - K * df : K * df - S);
  const upper = type === "C" ? S : K * df;
  if (price < intrinsic - 1e-9 || price >= upper) return null;

  const tol = 1e-8 * Math.max(1, price);
  let sigma = Math.sqrt((2 * Math.abs(Math.log(S / K) + r * T)) / T) || 0.5;
  sigma = Math.min(Math.max(sigma, 0.05), 3);
  for (let i = 0; i < 50; i++) {
    const g = bsGreeks({ S, K, T, sigma, r, type });
    const diff = g.price - price;
    if (Math.abs(diff) < tol) return sigma;
    if (g.vega < 1e-10) break;
    const next = sigma - diff / g.vega;
    if (!(next > 1e-4 && next < 10)) break;
    sigma = next;
  }
  let lo = 1e-4;
  let hi = 10;
  for (let i = 0; i < 200; i++) {
    const mid = 0.5 * (lo + hi);
    const p = bsPrice({ S, K, T, sigma: mid, r, type });
    if (Math.abs(p - price) < tol) return mid;
    if (p > price) hi = mid;
    else lo = mid;
  }
  const mid = 0.5 * (lo + hi);
  return Math.abs(bsPrice({ S, K, T, sigma: mid, r, type }) - price) < 1e-4 * Math.max(1, price) ? mid : null;
}

/** USD premium -> premium in coin (Deribit inverse quoting). */
export function toInversePremium(usdPremium: number, underlying: number) {
  return usdPremium / underlying;
}

/** Coin premium (Deribit mark_price) -> USD premium. */
export function fromInversePremium(coinPremium: number, underlying: number) {
  return coinPremium * underlying;
}

/** Delta of an inverse option measured in coin: USD delta minus the premium held in coin. */
export function inverseDelta(usdDelta: number, coinPremium: number) {
  return usdDelta - coinPremium;
}

export const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
export function yearsBetween(fromMs: number, toMs: number) {
  return (toMs - fromMs) / YEAR_MS;
}

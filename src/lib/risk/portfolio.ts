/**
 * Cross-position risk: net delta, beta-adjusted BTC exposure, correlated stress and
 * "which position liquidates first". MODELED — betas are assumptions, not observations.
 */
import type { PosSide } from "./exchanges";

export interface PortfolioPosition {
  id: string;
  asset: "BTC" | "ETH";
  side: PosSide;
  qty: number; // base units
  entry: number;
  liq: number | null;
  margin: number; // USD
}

export interface PortfolioContext {
  prices: { BTC: number; ETH: number };
  /** ETH return per 1 unit BTC return (beta). Default 1.2 — an assumption; estimate from data when available. */
  ethBeta?: number;
}

export interface PortfolioSummary {
  netDeltaUsd: number;
  grossUsd: number;
  btcBetaDeltaUsd: number;
  deltaPer100Btc: number; // USD PnL per +$100 BTC move, beta-adjusted
  totalMargin: number;
  /** BTC % move at which each position liquidates (beta-mapped for ETH). Sorted: first to liquidate first. */
  liquidationOrder: { id: string; btcShockPct: number | null; direction: "down" | "up" | null }[];
}

const sgn = (s: PosSide) => (s === "long" ? 1 : -1);
const beta = (a: "BTC" | "ETH", ctx: PortfolioContext) => (a === "BTC" ? 1 : ctx.ethBeta ?? 1.2);

export function summarize(positions: PortfolioPosition[], ctx: PortfolioContext): PortfolioSummary {
  let net = 0, gross = 0, betaDelta = 0, margin = 0;
  const order: PortfolioSummary["liquidationOrder"] = [];
  for (const p of positions) {
    const px = ctx.prices[p.asset];
    const d = sgn(p.side) * p.qty * px;
    net += d;
    gross += Math.abs(d);
    betaDelta += d * beta(p.asset, ctx);
    margin += p.margin;
    if (p.liq === null) order.push({ id: p.id, btcShockPct: null, direction: null });
    else {
      const move = p.liq / px - 1;
      order.push({ id: p.id, btcShockPct: move / beta(p.asset, ctx), direction: move < 0 ? "down" : "up" });
    }
  }
  order.sort((a, b) => (a.btcShockPct === null ? 1 : b.btcShockPct === null ? -1 : Math.abs(a.btcShockPct) - Math.abs(b.btcShockPct)));
  return { netDeltaUsd: net, grossUsd: gross, btcBetaDeltaUsd: betaDelta, deltaPer100Btc: (betaDelta * 100) / ctx.prices.BTC, totalMargin: margin, liquidationOrder: order };
}

export interface StressRow {
  btcShockPct: number;
  pnl: number;
  liquidated: string[];
  perPosition: { id: string; pnl: number; liquidated: boolean }[];
}

/** Shock BTC by each % (e.g. -0.1), ETH by beta × shock. Liquidated positions lose their margin. */
export function stress(positions: PortfolioPosition[], ctx: PortfolioContext, shocks = [-0.2, -0.1, -0.05, -0.02, 0.02, 0.05, 0.1, 0.2]): StressRow[] {
  return shocks.map((shock) => {
    const per = positions.map((p) => {
      const px0 = ctx.prices[p.asset];
      const px1 = px0 * (1 + shock * beta(p.asset, ctx));
      const liquidated = p.liq !== null && (p.side === "long" ? px1 <= p.liq : px1 >= p.liq);
      const pnl = liquidated ? -p.margin : sgn(p.side) * (px1 - p.entry) * p.qty;
      return { id: p.id, pnl, liquidated };
    });
    return { btcShockPct: shock, pnl: per.reduce((a, b) => a + b.pnl, 0), liquidated: per.filter((x) => x.liquidated).map((x) => x.id), perPosition: per };
  });
}

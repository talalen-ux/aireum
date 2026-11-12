/**
 * Exchange-specific liquidation & bankruptcy price formulas.
 *
 * All liquidation checks are evaluated against MARK price (not last traded price) — this is how
 * Binance, Bybit and OKX trigger forced liquidation. A stop order may trigger on LAST price, so a
 * stop that sits close to the liquidation price can still lose the race when mark and last diverge.
 *
 * IMPORTANT: maintenance-margin tables change. The tables below are best-effort transcriptions and are
 * versioned with `TIER_TABLE_VERSION`. Always cross-check against the venue's own position estimate
 * before relying on them. Outputs of this module are MODELED, never observed.
 */

export type RiskVenue = "binance" | "bybit" | "okx";
export type MarginMode = "isolated" | "cross";
export type ContractType = "linear" | "inverse";
export type PosSide = "long" | "short";

/** Version/date of the transcribed maintenance tables. Verify against the venue before production use. */
export const TIER_TABLE_VERSION = "approx-2025-Q1 (unverified transcription — cross-check venue brackets)";

export interface MaintenanceTier {
  /** Inclusive lower notional bound (USD for linear, USD contract value for inverse). */
  floor: number;
  /** Exclusive upper notional bound. */
  cap: number;
  maxLeverage: number;
  /** Maintenance margin rate, fraction. */
  mmr: number;
  /** Maintenance amount ("cum") — makes MM continuous across tiers. Derived, not transcribed. */
  cum: number;
}

/** Builds a tier table and derives each tier's maintenance amount so MM is continuous at boundaries. */
export function buildTiers(rows: Array<[cap: number, maxLeverage: number, mmr: number]>): MaintenanceTier[] {
  const out: MaintenanceTier[] = [];
  let floor = 0;
  let cum = 0;
  let prevMmr = 0;
  for (const [cap, maxLeverage, mmr] of rows) {
    if (out.length) cum += floor * (mmr - prevMmr);
    out.push({ floor, cap, maxLeverage, mmr, cum });
    floor = cap;
    prevMmr = mmr;
  }
  return out;
}

/** Binance USDⓈ-M BTCUSDT leverage & margin brackets (approximate). */
const BINANCE_BTCUSDT = buildTiers([
  [50_000, 125, 0.004],
  [600_000, 100, 0.005],
  [3_000_000, 75, 0.0065],
  [12_000_000, 50, 0.01],
  [70_000_000, 25, 0.02],
  [100_000_000, 20, 0.025],
  [230_000_000, 10, 0.05],
  [480_000_000, 5, 0.1],
  [600_000_000, 4, 0.125],
  [800_000_000, 3, 0.15],
  [1_200_000_000, 2, 0.25],
  [1_800_000_000, 1, 0.5],
]);

/** Binance USDⓈ-M ETHUSDT leverage & margin brackets (approximate). */
const BINANCE_ETHUSDT = buildTiers([
  [50_000, 125, 0.004],
  [600_000, 100, 0.005],
  [3_000_000, 75, 0.0065],
  [12_000_000, 50, 0.01],
  [50_000_000, 25, 0.02],
  [65_000_000, 20, 0.025],
  [150_000_000, 10, 0.05],
  [320_000_000, 5, 0.1],
  [400_000_000, 4, 0.125],
  [530_000_000, 3, 0.15],
  [800_000_000, 2, 0.25],
  [1_200_000_000, 1, 0.5],
]);

/** Bybit linear USDT perpetual risk-limit tiers (approximate). */
const BYBIT_BTCUSDT = buildTiers([
  [2_000_000, 100, 0.005],
  [10_000_000, 50, 0.01],
  [20_000_000, 25, 0.02],
  [40_000_000, 20, 0.025],
  [80_000_000, 10, 0.05],
  [160_000_000, 5, 0.1],
  [1_000_000_000, 2, 0.25],
]);
const BYBIT_ETHUSDT = buildTiers([
  [1_000_000, 100, 0.005],
  [5_000_000, 50, 0.01],
  [10_000_000, 25, 0.02],
  [20_000_000, 20, 0.025],
  [40_000_000, 10, 0.05],
  [80_000_000, 5, 0.1],
  [500_000_000, 2, 0.25],
]);

/** OKX USDT-margined swap position tiers (approximate). */
const OKX_BTCUSDT = buildTiers([
  [500_000, 100, 0.004],
  [2_000_000, 75, 0.005],
  [8_000_000, 50, 0.008],
  [20_000_000, 20, 0.015],
  [50_000_000, 10, 0.03],
  [150_000_000, 5, 0.06],
  [1_000_000_000, 2, 0.2],
]);
const OKX_ETHUSDT = buildTiers([
  [300_000, 100, 0.004],
  [1_500_000, 75, 0.005],
  [6_000_000, 50, 0.008],
  [15_000_000, 20, 0.015],
  [40_000_000, 10, 0.03],
  [120_000_000, 5, 0.06],
  [800_000_000, 2, 0.2],
]);

/** Binance COIN-M (inverse) BTCUSD_PERP brackets, notional in USD contract value (approximate). */
const BINANCE_COINM_BTC = buildTiers([
  [100_000, 125, 0.004],
  [500_000, 100, 0.005],
  [2_500_000, 50, 0.01],
  [10_000_000, 20, 0.025],
  [25_000_000, 10, 0.05],
  [100_000_000, 5, 0.1],
  [250_000_000, 4, 0.125],
  [1_000_000_000, 2, 0.25],
]);

export const TIER_TABLES: Record<RiskVenue, Record<"BTC" | "ETH", MaintenanceTier[]>> = {
  binance: { BTC: BINANCE_BTCUSDT, ETH: BINANCE_ETHUSDT },
  bybit: { BTC: BYBIT_BTCUSDT, ETH: BYBIT_ETHUSDT },
  okx: { BTC: OKX_BTCUSDT, ETH: OKX_ETHUSDT },
};
export const INVERSE_TIERS: MaintenanceTier[] = BINANCE_COINM_BTC;

export function tierFor(tiers: MaintenanceTier[], notional: number): MaintenanceTier {
  const n = Math.abs(notional);
  for (const t of tiers) if (n < t.cap) return t;
  return tiers[tiers.length - 1];
}

export interface LiqInput {
  venue: RiskVenue;
  asset: "BTC" | "ETH";
  side: PosSide;
  contract: ContractType;
  marginMode: MarginMode;
  /** Position size in BASE units (BTC/ETH). For inverse, base-equivalent at entry (USD notional / entry). */
  qty: number;
  entry: number;
  /**
   * Isolated: position margin (USD for linear, coin for inverse) including any added margin.
   * Cross: wallet balance available to this position (see `crossEffectiveMargin`).
   */
  margin: number;
  /** Estimated taker fee rate charged at liquidation (OKX/Bybit include close fee in MM). */
  closeFeeRate?: number;
  /** Override tiers (e.g. freshly fetched from the venue). */
  tiers?: MaintenanceTier[];
}

export interface LiqResult {
  liqPrice: number | null; // null => cannot be liquidated (over-collateralized) in that direction
  bankruptcyPrice: number | null;
  tier: MaintenanceTier;
  maintenanceMargin: number; // at entry, in margin currency
  mmr: number;
  formula: string;
  /** Liquidation is evaluated against MARK price. */
  trigger: "mark";
}

const sgn = (s: PosSide) => (s === "long" ? 1 : -1);

/**
 * Cross-margin effective collateral: the wallet balance minus maintenance of other positions plus
 * their unrealized PnL (Binance "WB - TMM1 + UPNL1"). Pass the result as `margin`.
 */
export function crossEffectiveMargin(walletBalance: number, otherMaintenance = 0, otherUpnl = 0) {
  return walletBalance - otherMaintenance + otherUpnl;
}

/**
 * Linear (USDT-margined) liquidation, generic "MM on mark" form used by Binance & OKX:
 *   margin + s·Q·(P − E) = Q·P·(mmr + feeRate) − cum
 *   ⇒ P = (margin + cum − s·Q·E) / (Q·(mmr + feeRate) − s·Q)
 * Binance one-way docs: LP = (WB − TMM + UPNL + cum − Side·Q·EP) / (Q·MMR − Side·Q).
 */
function linearMarkMM(qty: number, entry: number, side: PosSide, margin: number, mmr: number, cum: number, fee: number) {
  const s = sgn(side);
  const den = qty * (mmr + fee) - s * qty;
  if (den === 0) return null;
  const p = (margin + cum - s * qty * entry) / den;
  return p > 0 && Number.isFinite(p) ? p : null;
}

/**
 * Bybit classic isolated linear formula — maintenance computed on ENTRY value:
 *   Long  LP = E − (IM − MM) / Q        Short LP = E + (IM − MM) / Q
 * where IM is position margin (incl. added margin) and MM = Q·E·mmr − cum (+ est. close fee).
 */
function bybitLinear(qty: number, entry: number, side: PosSide, margin: number, mmr: number, cum: number, fee: number) {
  const mm = qty * entry * mmr - cum + qty * entry * fee;
  const p = side === "long" ? entry - (margin - mm) / qty : entry + (margin - mm) / qty;
  return p > 0 && Number.isFinite(p) ? p : null;
}

/**
 * Inverse (coin-margined, Binance COIN-M / Deribit style). N = USD notional (contracts × contract size).
 * Coin PnL long = N·(1/E − 1/P). Maintenance on mark-based coin value: mmr·N/P − cum.
 *   Long:  P = N·(1 + mmr) / (margin + N/E + cum)
 *   Short: P = N·(1 − mmr) / (N/E − margin − cum)      (no liquidation if denominator ≤ 0)
 * `cum` here is in COIN (the USD tier cum is converted at entry — approximation).
 */
function inverseLiq(notionalUsd: number, entry: number, side: PosSide, marginCoin: number, mmr: number, cumCoin: number) {
  if (side === "long") {
    const den = marginCoin + notionalUsd / entry + cumCoin;
    return den > 0 ? (notionalUsd * (1 + mmr)) / den : null;
  }
  const den = notionalUsd / entry - marginCoin - cumCoin;
  return den > 0 ? (notionalUsd * (1 - mmr)) / den : null;
}

export function bankruptcyPrice(input: Pick<LiqInput, "side" | "contract" | "qty" | "entry" | "margin">): number | null {
  const { side, contract, qty, entry, margin } = input;
  if (qty <= 0) return null;
  if (contract === "linear") {
    const p = side === "long" ? entry - margin / qty : entry + margin / qty;
    return p > 0 ? p : null;
  }
  const n = qty * entry;
  if (side === "long") return n / (margin + n / entry);
  const den = n / entry - margin;
  return den > 0 ? n / den : null;
}

/**
 * Liquidation price with tier resolution. Binance selects the bracket by notional at the liquidation
 * price, so we iterate tier selection to a fixed point (converges in ≤ a few steps).
 */
export function liquidationPrice(input: LiqInput): LiqResult {
  const { venue, asset, side, contract, qty, entry, margin } = input;
  const fee = input.closeFeeRate ?? (venue === "binance" ? 0 : 0.0005);
  const tiers = input.tiers ?? (contract === "inverse" ? INVERSE_TIERS : TIER_TABLES[venue][asset]);
  let tier = tierFor(tiers, qty * entry);
  let liq: number | null = null;
  let formula = "";
  for (let i = 0; i < 6; i++) {
    if (contract === "inverse") {
      const n = qty * entry;
      liq = inverseLiq(n, entry, side, margin, tier.mmr, tier.cum / entry);
      formula = side === "long" ? "P = N(1+mmr)/(M + N/E + cum)" : "P = N(1−mmr)/(N/E − M − cum)";
    } else if (venue === "bybit") {
      liq = bybitLinear(qty, entry, side, margin, tier.mmr, tier.cum, fee);
      formula = side === "long" ? "P = E − (IM − MM)/Q, MM on entry value" : "P = E + (IM − MM)/Q, MM on entry value";
    } else {
      liq = linearMarkMM(qty, entry, side, margin, tier.mmr, tier.cum, fee);
      formula = "P = (M + cum − s·Q·E) / (Q·(mmr+fee) − s·Q), MM on mark";
    }
    if (liq === null || venue !== "binance") break;
    const next = tierFor(tiers, qty * liq);
    if (next === tier) break;
    tier = next;
  }
  const mm = contract === "inverse" ? (qty * entry * tier.mmr - tier.cum) / entry : qty * entry * tier.mmr - tier.cum;
  return {
    liqPrice: liq,
    bankruptcyPrice: bankruptcyPrice(input),
    tier,
    maintenanceMargin: Math.max(0, mm),
    mmr: tier.mmr,
    formula,
    trigger: "mark",
  };
}

/** Max leverage allowed for a given notional on the venue's tier table. */
export function maxLeverageFor(venue: RiskVenue, asset: "BTC" | "ETH", notional: number, contract: ContractType = "linear") {
  const tiers = contract === "inverse" ? INVERSE_TIERS : TIER_TABLES[venue][asset];
  return tierFor(tiers, notional).maxLeverage;
}

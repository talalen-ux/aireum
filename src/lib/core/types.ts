/**
 * ATLAS core type contract.
 *
 * Every normalized event carries full provenance: venue, symbol, contract type,
 * exchange event timestamp, local receipt timestamp, units, source and quality
 * flags. Downstream code must never fabricate values: when data is missing the
 * correct output is `null` / an `Unavailable` status, not a guess.
 */

export type Venue =
  | "binance"
  | "bybit"
  | "okx"
  | "bitfinex"
  | "deribit"
  | "hyperliquid"
  | "kucoin"
  | "coinbase"
  | "kraken"
  | "sim"; // synthetic simulator — always labeled SIMULATION in the UI

export type MarketType = "spot" | "perp" | "future" | "option";

/** Linear: PnL & margin in quote (USDT/USDC/USD). Inverse: PnL & margin in base (BTC). */
export type ContractKind = "spot" | "linear" | "inverse";

export type Asset = "BTC" | "ETH";

/** How a value was obtained — the UI must render these distinctly. */
export type Provenance = "observed" | "modeled" | "inferred";

export type DataMode = "live" | "simulation" | "replay";

export type QualityFlag =
  | "ok"
  | "stale" // no update within expected interval
  | "gap" // sequence gap detected; book resyncing
  | "resynced" // recovered after a gap
  | "clock_drift" // exchange ts vs receipt ts drift beyond tolerance
  | "duplicate" // duplicate trade id dropped
  | "rate_limited"
  | "checksum_fail"
  | "unavailable";

export interface InstrumentRef {
  venue: Venue;
  /** Venue-native symbol, e.g. BTCUSDT, BTC-USDT-SWAP, BTC-PERPETUAL */
  symbol: string;
  asset: Asset;
  market: MarketType;
  contract: ContractKind;
  /** Quote currency for prices, e.g. USDT, USD, USDC */
  quote: string;
  /** Contract multiplier: base units (linear) or USD (inverse) per contract. 1 for spot/most linear. */
  multiplier: number;
}

export interface EventMeta {
  inst: InstrumentRef;
  /** Exchange event time, ms epoch (null if the venue does not supply one). */
  exchTs: number | null;
  /** Local receipt time, ms epoch. */
  recvTs: number;
  source: string; // e.g. "binance.fapi.ws.aggTrade"
  quality: QualityFlag[];
}

export interface TradeEvent extends EventMeta {
  kind: "trade";
  id: string;
  price: number;
  /** Size in BASE units (BTC/ETH) after multiplier normalization. */
  size: number;
  /** Aggressor side. "buy" = market buy lifted the ask. */
  side: "buy" | "sell";
}

export type BookLevel = [price: number, size: number]; // size in BASE units

export interface BookSnapshotEvent extends EventMeta {
  kind: "book_snapshot";
  bids: BookLevel[]; // descending
  asks: BookLevel[]; // ascending
  seq: number | null;
}

export interface BookDeltaEvent extends EventMeta {
  kind: "book_delta";
  /** Absolute size per level; 0 removes the level. */
  bids: BookLevel[];
  asks: BookLevel[];
  /** First and last sequence ids covered by this delta (venue semantics normalized by adapter). */
  seqFirst: number | null;
  seqLast: number | null;
  /** Previous sequence id the venue claims precedes this update (if venue supplies it). */
  prevSeq: number | null;
}

/** An actual liquidation reported by the venue (observed). Never mix with modeled clusters. */
export interface LiquidationEvent extends EventMeta {
  kind: "liquidation";
  price: number;
  size: number; // base units
  /** Side of the position that was liquidated. A long liquidation is a forced SELL. */
  positionSide: "long" | "short";
}

export interface OpenInterestEvent extends EventMeta {
  kind: "open_interest";
  /** OI in BASE units (normalized). */
  oiBase: number;
  /** OI in USD notional (normalized). */
  oiUsd: number;
}

export interface FundingEvent extends EventMeta {
  kind: "funding";
  /** Current/predicted funding rate per interval, as a fraction (0.0001 = 1bp). */
  rate: number;
  intervalHours: number;
  nextFundingTs: number | null;
}

export interface MarkIndexEvent extends EventMeta {
  kind: "mark_index";
  mark: number | null;
  index: number | null;
  last: number | null;
}

export interface FeedStatusEvent {
  kind: "feed_status";
  venue: Venue;
  symbol: string;
  market: MarketType;
  state: FeedState;
  detail?: string;
  ts: number;
}

export type FeedState =
  | "connecting"
  | "syncing"
  | "live"
  | "gap_recovering"
  | "stale"
  | "disconnected"
  | "unavailable"; // blocked by CORS/geo/licensing — degrade visibly, never invent

export type MarketEvent =
  | TradeEvent
  | BookSnapshotEvent
  | BookDeltaEvent
  | LiquidationEvent
  | OpenInterestEvent
  | FundingEvent
  | MarkIndexEvent;

export type AnyEvent = MarketEvent | FeedStatusEvent;

/** Adapter contract: every venue integration implements this. */
export interface VenueAdapter {
  readonly venue: Venue;
  readonly instruments: InstrumentRef[];
  start(emit: (e: AnyEvent) => void): void;
  stop(): void;
}

/** A documented, auditable feature definition (Market Regime Engine requirement). */
export interface FeatureSpec {
  id: string;
  name: string;
  formula: string; // human-readable math
  window: string;
  normalization: "robust_z" | "percentile" | "vol_adjusted_z" | "raw";
  provenance: Provenance;
  sources: string[];
  weight: number;
  reliability: "high" | "medium" | "low";
}

export interface FeatureValue {
  id: string;
  raw: number | null;
  z: number | null; // normalized value; null if insufficient history
  ts: number;
}

export type Timeframe = "5m" | "15m" | "1h" | "4h" | "1d" | "1w";
export const TIMEFRAMES: Timeframe[] = ["5m", "15m", "1h", "4h", "1d", "1w"];
export const TF_MS: Record<Timeframe, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

export type Side = "long" | "short";

/** Evidence item attached to every score / hypothesis — every metric expands to this. */
export interface Evidence {
  label: string;
  value: string;
  provenance: Provenance;
  /** +1 supports, -1 contradicts, 0 neutral/context */
  stance: 1 | -1 | 0;
  source: string;
  ts: number;
}

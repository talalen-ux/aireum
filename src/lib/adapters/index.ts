import type { Asset, MarketType, Venue, VenueAdapter } from "../core/types";
import type { AdapterOptions } from "./base";
import { BinanceAdapter } from "./binance";
import { BitfinexAdapter } from "./bitfinex";
import { BybitAdapter } from "./bybit";
import { CoinbaseAdapter } from "./coinbase";
import { DeribitAdapter } from "./deribit";
import { HyperliquidAdapter } from "./hyperliquid";
import { KrakenAdapter } from "./kraken";
import { KucoinAdapter } from "./kucoin";
import { OkxAdapter } from "./okx";

export { BinanceAdapter, BitfinexAdapter, BybitAdapter, CoinbaseAdapter, DeribitAdapter, HyperliquidAdapter, KrakenAdapter, KucoinAdapter, OkxAdapter };
export type { AdapterOptions } from "./base";

export interface VenueCatalogEntry {
  venue: Exclude<Venue, "sim">;
  name: string;
  markets: MarketType[];
  book: string;
  integrity: string;
  observedLiquidations: boolean;
  openInterest: boolean;
  funding: boolean;
  notes: string;
}

/** Venue capabilities and caveats — surfaced in the UI so users know what is (not) covered. */
export const VENUE_CATALOG: VenueCatalogEntry[] = [
  { venue: "binance", name: "Binance", markets: ["spot", "perp"], book: "diff depth @100ms + REST snapshot (1000 lvls)", integrity: "U/u (spot) and pu (futures) sequence chaining", observedLiquidations: true, openInterest: true, funding: true, notes: "OI via REST poll (10s). forceOrder stream is throttled by Binance to ≤1 liquidation per symbol per 1000ms, so observed liquidations are a lower bound. Geo-restricted in some jurisdictions (HTTP 451) → shown as Unavailable." },
  { venue: "bybit", name: "Bybit", markets: ["spot", "perp"], book: "orderbook.200 snapshot + delta", integrity: "monotonic update id u; u=1 / snapshot resets", observedLiquidations: true, openInterest: true, funding: true, notes: "allLiquidation stream (linear). Ticker deltas are merged into full state." },
  { venue: "okx", name: "OKX", markets: ["spot", "perp"], book: "books (400 lvls) snapshot + update", integrity: "seqId/prevSeqId chaining + CRC32 checksum (top 25)", observedLiquidations: true, openInterest: true, funding: true, notes: "Swap sizes normalized from contracts via ctVal (0.01 BTC / 0.1 ETH). liquidation-orders is venue-sampled." },
  { venue: "coinbase", name: "Coinbase", markets: ["spot"], book: "Advanced Trade level2 snapshot + update", integrity: "per-connection sequence_num continuity", observedLiquidations: false, openInterest: false, funding: false, notes: "Spot only (USD). Key US spot demand signal." },
  { venue: "kraken", name: "Kraken", markets: ["spot"], book: "WS v2 book depth 500", integrity: "CRC32 checksum (top 10) with local truncation", observedLiquidations: false, openInterest: false, funding: false, notes: "Spot USD." },
  { venue: "hyperliquid", name: "Hyperliquid", markets: ["perp"], book: "l2Book full snapshots (~20 lvls)", integrity: "full-snapshot stream (no incremental state)", observedLiquidations: false, openInterest: true, funding: true, notes: "Hourly funding; shallow book depth (top 20). On-chain liquidations not exposed on this public stream." },
  { venue: "deribit", name: "Deribit", markets: ["perp"], book: "book.100ms snapshot + change", integrity: "change_id/prev_change_id chaining", observedLiquidations: true, openInterest: true, funding: true, notes: "Inverse perpetual; USD amounts converted to base by price. Liquidations from trade liquidation flags. Options handled by the options module." },
  { venue: "bitfinex", name: "Bitfinex", markets: ["spot", "perp"], book: "P0 F0 len 100", integrity: "CRC32 checksum (top 25) via conf flag", observedLiquidations: true, openInterest: false, funding: false, notes: "Spot book/trades; perp used only for global liquidation feed." },
  { venue: "kucoin", name: "KuCoin", markets: ["spot"], book: "level2Depth50 full snapshots", integrity: "full-snapshot stream", observedLiquidations: false, openInterest: false, funding: false, notes: "Needs a token from POST bullet-public, commonly CORS-blocked in browsers → Unavailable unless proxied server-side." },
];

export const ALL_VENUES = VENUE_CATALOG.map((v) => v.venue);

const CTORS: Record<Exclude<Venue, "sim">, new (asset: Asset, opts?: AdapterOptions) => VenueAdapter> = {
  binance: BinanceAdapter,
  bybit: BybitAdapter,
  okx: OkxAdapter,
  coinbase: CoinbaseAdapter,
  kraken: KrakenAdapter,
  hyperliquid: HyperliquidAdapter,
  deribit: DeribitAdapter,
  bitfinex: BitfinexAdapter,
  kucoin: KucoinAdapter,
};

/** Create live adapters for an asset. `venues` defaults to every catalog venue. */
export function createAdapters(asset: Asset, venues?: Venue[], opts?: AdapterOptions): VenueAdapter[] {
  const list = (venues ?? ALL_VENUES).filter((v): v is Exclude<Venue, "sim"> => v !== "sim" && v in CTORS);
  return list.map((v) => new CTORS[v](asset, opts));
}

/** Start several adapters with one sink; returns a stop function. */
export function subscribeAll(adapters: VenueAdapter[], emit: Parameters<VenueAdapter["start"]>[0]) {
  for (const a of adapters) a.start(emit);
  return () => {
    for (const a of adapters) a.stop();
  };
}

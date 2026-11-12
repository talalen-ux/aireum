import type { OptType } from "./blackscholes";

export type OptionAsset = "BTC" | "ETH";

export interface OptionRow {
  instrument: string;
  /** Expiry timestamp, ms epoch (Deribit expiries settle 08:00 UTC). */
  expiry: number;
  strike: number;
  type: OptType;
  /** Open interest in underlying coin units (Deribit: 1 contract = 1 coin). */
  oi: number;
  /** 24h volume in underlying coin units. */
  volume: number;
  /** Mark implied vol as a fraction (0.55 = 55%). null if venue did not supply it. */
  markIv: number | null;
  bidIv?: number | null;
  askIv?: number | null;
  delta?: number | null;
  /** Forward/underlying used by the venue for this expiry. */
  underlyingPrice?: number | null;
  /** Mark price in coin (inverse premium). */
  markPrice?: number | null;
}

export interface OptionChain {
  status: "ok";
  asset: OptionAsset;
  /** Time the chain was received (ms epoch). */
  asOf: number;
  /** Index / spot price used as reference. */
  underlying: number;
  rows: OptionRow[];
  source: string;
  provenance: "observed" | "simulated";
  mode: "live" | "simulation";
  /** Redistribution / licensing note shown in the UI. */
  licensing: string;
}

export interface ChainUnavailable {
  status: "unavailable";
  asset: OptionAsset;
  asOf: number;
  reason: string;
  source: string;
}

export type ChainResult = OptionChain | ChainUnavailable;

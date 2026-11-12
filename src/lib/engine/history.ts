import type { Asset, Timeframe } from "../core/types";
import { TF_MS } from "../core/types";
import type { Bar } from "./bars";
import { emptyBar } from "./bars";

/**
 * Point-in-time history bootstrap so multi-timeframe regimes are meaningful from
 * the first second. Reference venue: Binance (spot klines carry taker-buy volume →
 * exact signed flow per bar). Fallback: Bybit OHLCV (no aggressor split → flow = null,
 * the UI shows flow features as warming up instead of inventing them).
 */
export interface HistoryResult {
  bars: Partial<Record<Timeframe, Bar[]>>;
  source: string;
  flowAvailable: boolean;
  errors: string[];
}

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const BINANCE_TF: Record<Timeframe, string> = { "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w" };
const OI_PERIOD: Partial<Record<Timeframe, string>> = { "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
const LIMIT: Record<Timeframe, number> = { "5m": 1000, "15m": 1000, "1h": 1000, "4h": 1000, "1d": 1000, "1w": 400 };

type Kline = [number, string, string, string, string, string, number, string, number, string, string, string];

async function getJson<T>(f: Fetch, url: string): Promise<T> {
  const r = await f(url);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return (await r.json()) as T;
}

export async function loadHistory(asset: Asset, tfs: Timeframe[], fetchImpl: Fetch = fetch as unknown as Fetch): Promise<HistoryResult> {
  const errors: string[] = [];
  try {
    return await loadBinance(asset, tfs, fetchImpl, errors);
  } catch (e) {
    errors.push(`binance: ${(e as Error).message}`);
  }
  try {
    return await loadBybit(asset, tfs, fetchImpl, errors);
  } catch (e) {
    errors.push(`bybit: ${(e as Error).message}`);
  }
  return { bars: {}, source: "none", flowAvailable: false, errors };
}

async function loadBinance(asset: Asset, tfs: Timeframe[], f: Fetch, errors: string[]): Promise<HistoryResult> {
  const sym = `${asset}USDT`;
  const out: HistoryResult["bars"] = {};
  let funding: { fundingTime: number; fundingRate: string }[] = [];
  try {
    funding = await getJson(f, `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&limit=1000`);
  } catch (e) {
    errors.push(`funding history: ${(e as Error).message}`);
  }
  await Promise.all(
    tfs.map(async (tf) => {
      const [spot, perp] = await Promise.all([
        getJson<Kline[]>(f, `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${BINANCE_TF[tf]}&limit=${LIMIT[tf]}`),
        getJson<Kline[]>(f, `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${BINANCE_TF[tf]}&limit=${LIMIT[tf]}`).catch((e) => {
          errors.push(`perp klines ${tf}: ${(e as Error).message}`);
          return [] as Kline[];
        }),
      ]);
      let oi: { timestamp: number; sumOpenInterest: string }[] = [];
      const p = OI_PERIOD[tf];
      if (p) {
        try {
          oi = await getJson(f, `https://fapi.binance.com/futures/data/openInterestHist?symbol=${sym}&period=${p}&limit=500`);
        } catch (e) {
          errors.push(`OI history ${tf}: ${(e as Error).message}`);
        }
      }
      out[tf] = mergeBinance(tf, spot, perp, oi, funding);
    }),
  );
  return { bars: out, source: "binance (spot+usdm klines, OI hist, funding)", flowAvailable: true, errors };
}

export function mergeBinance(tf: Timeframe, spot: Kline[], perp: Kline[], oi: { timestamp: number; sumOpenInterest: string }[], funding: { fundingTime: number; fundingRate: string }[]): Bar[] {
  const perpMap = new Map(perp.map((k) => [k[0], k]));
  const ms = TF_MS[tf];
  // OI hist timestamps mark the period END in practice; key by containing bar open.
  const oiMap = new Map<number, number>();
  for (const o of oi) oiMap.set(Math.floor((o.timestamp - 1) / ms) * ms, Number(o.sumOpenInterest));
  const fund = [...funding].sort((a, b) => a.fundingTime - b.fundingTime);
  let fi = 0;
  let lastOi: number | null = null;
  return spot.map((k) => {
    const b = emptyBar(k[0], Number(k[1]));
    b.o = Number(k[1]); b.h = Number(k[2]); b.l = Number(k[3]); b.c = Number(k[4]);
    const vol = Number(k[5]);
    const tb = Number(k[9]);
    b.spotBuy = tb;
    b.spotSell = Math.max(0, vol - tb);
    const pk = perpMap.get(k[0]);
    if (pk) {
      const pv = Number(pk[5]);
      const ptb = Number(pk[9]);
      b.perpBuy = ptb;
      b.perpSell = Math.max(0, pv - ptb);
      const pc = Number(pk[4]);
      b.basisBps = ((pc - b.c) / b.c) * 10_000;
    }
    // align OI to bar: use the OI observed at/inside this bar; carry forward only past values (point-in-time)
    const o = oiMap.get(k[0]);
    if (o !== undefined) lastOi = o;
    b.oi = o !== undefined ? o : lastOi;
    const closeT = k[0] + ms;
    while (fi < fund.length && fund[fi].fundingTime <= closeT) fi++;
    b.funding = fi > 0 ? Number(fund[fi - 1].fundingRate) : null;
    return b;
  });
}

const BYBIT_TF: Record<Timeframe, string> = { "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D", "1w": "W" };

async function loadBybit(asset: Asset, tfs: Timeframe[], f: Fetch, errors: string[]): Promise<HistoryResult> {
  const sym = `${asset}USDT`;
  const out: HistoryResult["bars"] = {};
  await Promise.all(
    tfs.map(async (tf) => {
      const r = await getJson<{ result: { list: string[][] } }>(f, `https://api.bybit.com/v5/market/kline?category=spot&symbol=${sym}&interval=${BYBIT_TF[tf]}&limit=1000`);
      const bars = r.result.list
        .map((k) => {
          const b = emptyBar(Number(k[0]), Number(k[1]));
          b.o = Number(k[1]); b.h = Number(k[2]); b.l = Number(k[3]); b.c = Number(k[4]);
          return b;
        })
        .sort((a, b) => a.t - b.t);
      out[tf] = bars;
    }),
  );
  errors.push("bybit fallback: klines lack aggressor split → historical flow features unavailable until live warmup");
  return { bars: out, source: "bybit (spot klines, OHLC only)", flowAvailable: false, errors };
}

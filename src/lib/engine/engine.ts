import type { AnyEvent, Asset, DataMode, MarketType, Timeframe, TradeEvent, Venue } from "../core/types";
import { TIMEFRAMES } from "../core/types";
import { consolidate } from "../core/orderbook";
import { median } from "../core/stats";
import { BarSeries, atr, type Bar } from "./bars";
import { FeatureStore } from "./features";
import { assessTimeframe, type TfAssessment } from "./regime";
import { evaluateExhaustion, type BookPressure, type ExhaustionSignal, type AnalogStats } from "./exhaustion";
import { buildLiqMap, niceStep, type LiqMap } from "./liqmodel";
import { ImpactTracker, LargeTrades, Stream, WallTracker, computeLeadLag, sampleStream, streamKey, venueRow, type LeadLag, type VenueRow, type WallInfo } from "./micro";
import { OpportunityBook, detectorStatus, refreshAnalogs, runDetectors, type AuditEntry, type DetectorContext, type DetectorStatus, type Opportunity } from "./detectors";

export interface HeatColumn {
  t: number;
  i0: number; // first bucket index (bucket price = i * step)
  vals: number[]; // resting USD per bucket (bids below mid, asks above)
  mid: number;
}

export interface FlowPoint {
  t: number;
  price: number | null;
  spotCvd: number; // cumulative base since session start (all venues)
  perpCvd: number;
}

export interface EngineSnapshot {
  asset: Asset;
  mode: DataMode;
  ts: number;
  sessionStart: number;
  price: number | null;
  priceSource: string | null;
  priceTs: number | null;
  change24h: number | null;
  venues: VenueRow[];
  liveVenues: number;
  totalStreams: number;
  history: { source: string; flowAvailable: boolean; errors: string[]; loaded: boolean };
  assessments: Partial<Record<Timeframe, TfAssessment>>;
  bars1m: Bar[];
  chartBars: Partial<Record<Timeframe, Bar[]>>;
  flow: FlowPoint[];
  venueCvd: { key: string; usd: number }[];
  impact: ReturnType<ImpactTracker["compute"]> | null;
  leadLag: LeadLag | null;
  largeTrades: LargeTrades["tape"];
  walls: WallInfo[];
  pulledWalls: WallTracker["pulled"];
  liquidations: { ts: number; venue: Venue; side: "long" | "short"; price: number; usd: number }[];
  liqTotals: { long5m: number; short5m: number; long1h: number; short1h: number };
  liqMap: LiqMap | null;
  exhaustion: { long: ExhaustionSignal | null; short: ExhaustionSignal | null; tf: "1m" | "5m" };
  analogs: Record<string, AnalogStats>;
  opportunities: Opportunity[];
  recentOpportunities: Opportunity[];
  detectors: DetectorStatus[];
  audit: AuditEntry[];
  heat: { step: number; cols: HeatColumn[] }; // incremental columns since last snapshot
  bookPressure: BookPressure | null;
  aggDepth: { bid25: number; ask25: number; bid100: number; ask100: number } | null;
  oiTotalUsd: number | null;
  fundingAvg8h: number | null;
  atr1m: number | null;
  atr5m: number | null;
  returns1m: number[];
  eventsPerSec: number;
  recording: boolean;
  recordedEvents: number;
}

const SPOT_PRIORITY: Venue[] = ["binance", "coinbase", "okx", "bybit", "kraken", "bitfinex", "kucoin", "sim"];
const PERP_PRIORITY: Venue[] = ["binance", "bybit", "okx", "hyperliquid", "deribit", "bitfinex", "sim"];

export class Engine {
  readonly streams = new Map<string, Stream>();
  readonly series: Record<Timeframe, BarSeries>;
  readonly bars1m = new BarSeries("1m", 720);
  private stores: Record<Timeframe, FeatureStore>;
  private impact = new ImpactTracker();
  private large: LargeTrades;
  private walls = new WallTracker();
  private opp = new OpportunityBook();
  private liqs: EngineSnapshot["liquidations"] = [];
  private flow: FlowPoint[] = [];
  private spotCvd = 0;
  private perpCvd = 0;
  private venueCvd = new Map<string, number>();
  private heatCols: HeatColumn[] = [];
  private heatStep: number | null = null;
  private depthHist: { t: number; bid100: number; ask100: number }[] = [];
  private assessments: Partial<Record<Timeframe, TfAssessment>> = {};
  private analogCache = new Map<string, AnalogStats>();
  private lastAnalogBar = 0;
  private leadLag: LeadLag | null = null;
  private liqMap: LiqMap | null = null;
  private impactRes: EngineSnapshot["impact"] = null;
  private exh: EngineSnapshot["exhaustion"] = { long: null, short: null, tf: "5m" };
  private detStatus: DetectorStatus[] = [];
  private evCount = 0;
  private evRate = 0;
  private lastRateTs = 0;
  private lastTick = 0;
  private tickN = 0;
  private clock: number;
  readonly sessionStart: number;
  history = { source: "pending", flowAvailable: false, errors: [] as string[], loaded: false };
  recording = false;
  recorded: AnyEvent[] = [];

  constructor(readonly asset: Asset, readonly mode: DataMode, now = Date.now()) {
    this.clock = now;
    this.sessionStart = now;
    this.series = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, new BarSeries(tf, 1500)])) as Record<Timeframe, BarSeries>;
    this.stores = Object.fromEntries(TIMEFRAMES.map((tf) => [tf, new FeatureStore(12, 500)])) as Record<Timeframe, FeatureStore>;
    this.large = new LargeTrades(asset === "BTC" ? 250_000 : 150_000);
  }

  now() {
    return this.mode === "replay" ? this.clock : Math.max(this.clock, Date.now());
  }

  loadHistory(bars: Partial<Record<Timeframe, Bar[]>>, meta: { source: string; flowAvailable: boolean; errors: string[] }) {
    for (const tf of TIMEFRAMES) if (bars[tf]?.length) this.series[tf].mergeHistory(bars[tf]!);
    this.history = { ...meta, loaded: true };
  }

  private stream(venue: Venue, market: MarketType, inst?: TradeEvent["inst"]): Stream | undefined {
    const k = streamKey(venue, market);
    let s = this.streams.get(k);
    if (!s && inst) { s = new Stream(inst); this.streams.set(k, s); }
    return s;
  }

  private refStream(market: "spot" | "perp"): Stream | undefined {
    const pr = market === "spot" ? SPOT_PRIORITY : PERP_PRIORITY;
    for (const v of pr) {
      const s = this.streams.get(streamKey(v, market));
      if (s && (s.state === "live" || s.state === "syncing") && s.lastTrade) return s;
    }
    return undefined;
  }

  ingest(e: AnyEvent) {
    this.evCount++;
    if (this.recording) { this.recorded.push(e); if (this.recorded.length > 400_000) this.recorded.shift(); }
    if (e.kind === "feed_status") {
      const k = streamKey(e.venue, e.market);
      let s = this.streams.get(k);
      if (!s) {
        s = new Stream({ venue: e.venue, symbol: e.symbol, asset: this.asset, market: e.market, contract: e.market === "spot" ? "spot" : "linear", quote: "USD", multiplier: 1 });
        this.streams.set(k, s);
      }
      s.state = e.state;
      s.stateDetail = e.detail ?? "";
      if (e.state === "gap_recovering") { s.book.invalidate(); s.qualityFlags.add("gap"); }
      if (this.mode === "replay") this.clock = Math.max(this.clock, e.ts);
      return;
    }
    if (this.mode === "replay") this.clock = Math.max(this.clock, e.recvTs);
    const s = this.stream(e.inst.venue, e.inst.market, e.inst)!;
    s.lastMsg = e.recvTs;
    if (e.exchTs) s.latencies.push(Math.max(0, e.recvTs - e.exchTs));
    for (const q of e.quality) if (q !== "ok") s.qualityFlags.add(q);
    const ts = e.exchTs ?? e.recvTs;
    switch (e.kind) {
      case "book_snapshot":
        s.book.applySnapshot(e);
        if (s.state !== "live") s.state = "live";
        s.qualityFlags.delete("gap");
        break;
      case "book_delta": {
        const r = s.book.applyDelta(e);
        if (r === "gap") { s.state = "gap_recovering"; s.qualityFlags.add("gap"); }
        else if (r === "applied" && s.state !== "live" && s.state !== "stale") s.state = "live";
        break;
      }
      case "trade": {
        s.lastTrade = e;
        s.trades++;
        if (s.state === "connecting" || s.state === "syncing") s.state = s.book.valid ? "live" : s.state;
        const mkt = e.inst.market === "spot" ? "spot" : "perp";
        const signed = e.side === "buy" ? e.size : -e.size;
        if (mkt === "spot") this.spotCvd += signed; else this.perpCvd += signed;
        this.venueCvd.set(s.key, (this.venueCvd.get(s.key) ?? 0) + signed * e.price);
        this.impact.onTrade(ts, e.price * e.size, e.side);
        this.large.onTrade(e);
        // reference-venue bars (consistent with history source)
        const ref = this.refStream(mkt);
        if (!ref || ref === s) {
          for (const tf of TIMEFRAMES) this.series[tf].onTrade(ts, e.price, e.size, e.side, mkt);
          this.bars1m.onTrade(ts, e.price, e.size, e.side, mkt);
        }
        const refSpot = this.refStream("spot") ?? this.refStream("perp");
        if (!refSpot || refSpot === s) {
          for (const tf of TIMEFRAMES) this.series[tf].onPrice(ts, e.price);
          this.bars1m.onPrice(ts, e.price);
        }
        break;
      }
      case "liquidation": {
        const usd = e.price * e.size;
        this.liqs.unshift({ ts, venue: e.inst.venue, side: e.positionSide, price: e.price, usd });
        if (this.liqs.length > 400) this.liqs.pop();
        for (const tf of TIMEFRAMES) this.series[tf].onLiq(ts, e.price, e.size, e.positionSide);
        this.bars1m.onLiq(ts, e.price, e.size, e.positionSide);
        break;
      }
      case "open_interest": {
        s.oiBase = e.oiBase; s.oiUsd = e.oiUsd;
        const ref = this.refStream("perp");
        if (!ref || ref === s) {
          const px = s.lastTrade?.price ?? e.oiUsd / e.oiBase;
          for (const tf of TIMEFRAMES) this.series[tf].setField(ts, px, "oi", e.oiBase);
          this.bars1m.setField(ts, px, "oi", e.oiBase);
        }
        break;
      }
      case "funding": {
        s.funding = e.rate; s.fundingInterval = e.intervalHours; s.nextFunding = e.nextFundingTs;
        const ref = this.refStream("perp");
        if (!ref || ref === s) {
          const f8 = e.rate * (8 / (e.intervalHours || 8));
          const px = s.lastTrade?.price ?? 0;
          if (px) { for (const tf of TIMEFRAMES) this.series[tf].setField(ts, px, "funding", f8); this.bars1m.setField(ts, px, "funding", f8); }
        }
        break;
      }
      case "mark_index":
        if (e.mark !== null) s.mark = e.mark;
        if (e.index !== null) s.index = e.index;
        break;
    }
  }

  /** Called ~every 250ms by the host; does heavier work at slower cadences. */
  tick() {
    const now = this.now();
    if (now - this.lastTick < 1000) return;
    this.lastTick = now;
    this.tickN++;
    const all = [...this.streams.values()];
    // staleness
    for (const s of all) {
      if (s.state === "live" && s.lastMsg && now - s.lastMsg > 20_000) { s.state = "stale"; s.qualityFlags.add("stale"); }
      sampleStream(s, now);
    }
    if (now - this.lastRateTs >= 5000) { this.evRate = this.evCount / Math.max(1, (now - this.lastRateTs) / 1000); this.evCount = 0; this.lastRateTs = now; }

    const price = this.price();
    if (price !== null) {
      this.impact.onMid(now, price);
      // basis on bars
      const sp = this.refStream("spot"), pp = this.refStream("perp");
      const spx = sp?.book.mid() ?? sp?.lastTrade?.price, ppx = pp?.book.mid() ?? pp?.lastTrade?.price;
      if (spx && ppx) { const bb = ((ppx - spx) / spx) * 10_000; for (const tf of TIMEFRAMES) this.series[tf].setField(now, price, "basisBps", bb); this.bars1m.setField(now, price, "basisBps", bb); }
    }
    this.flow.push({ t: now, price, spotCvd: this.spotCvd, perpCvd: this.perpCvd });
    if (this.flow.length > 1800) this.flow.shift();

    // walls / heatmap / depth
    const books = all.filter((s) => s.book.valid);
    for (const s of books) this.walls.update(s.key, s.book, now, this.asset === "BTC" ? 1_500_000 : 750_000);
    if (price !== null && books.length) {
      if (this.heatStep === null || Math.abs(price / (this.heatStep * 1000) - 1) > 0.5) this.heatStep = niceStep(price * 0.0003);
      const step = this.heatStep;
      const c = consolidate(books.map((s) => s.book), step, 150);
      if (c) {
        const lo = Math.floor((price * 0.985) / step), hi = Math.ceil((price * 1.015) / step);
        const vals: number[] = [];
        for (let i = lo; i <= hi; i++) { const p = i * step; vals.push(((c.bids.get(p) ?? 0) + (c.asks.get(p) ?? 0)) * p); }
        this.heatCols.push({ t: now, i0: lo, vals, mid: price });
        if (this.heatCols.length > 900) this.heatCols.shift();
      }
      const ad = this.aggDepth();
      if (ad) { this.depthHist.push({ t: now, bid100: ad.bid100, ask100: ad.ask100 }); if (this.depthHist.length > 900) this.depthHist.shift(); }
    }

    if (this.tickN % 5 === 1) { this.leadLag = computeLeadLag(all.filter((s) => s.book.valid), now); this.impactRes = this.impact.compute(now); }

    // regimes + detectors every 2s
    if (this.tickN % 2 === 1) {
      const frag = this.bookFragility();
      for (const tf of TIMEFRAMES) {
        this.assessments[tf] = assessTimeframe(tf, this.series[tf].bars, this.stores[tf], { flowAvailable: this.history.flowAvailable || this.mode !== "live", liveBookFragility: tf === "5m" || tf === "15m" ? frag : null, macroAvailable: false });
      }
      const bp = this.bookPressure();
      const use1m = this.bars1m.bars.length >= 80;
      const src = use1m ? this.bars1m.bars : this.series["5m"].bars;
      this.exh = { long: evaluateExhaustion(src, "long", use1m ? bp : null), short: evaluateExhaustion(src, "short", use1m ? bp : null), tf: use1m ? "1m" : "5m" };
      const venues = this.venueRows(now);
      const ctx: DetectorContext = {
        now, price, bars1m: this.bars1m.bars, bars: Object.fromEntries(TIMEFRAMES.map((tf) => [tf, this.series[tf].bars])), assess: this.assessments, book: bp, venues, leadLag: this.leadLag, liq: this.liqMap, depthHist: this.depthHist, analogCache: this.analogCache, optionsAvailable: false, macroAvailable: false,
      };
      this.opp.update(runDetectors(ctx), now, price);
      this.detStatus = detectorStatus(ctx);
    }
    if (this.tickN % 10 === 1 || !this.liqMap) {
      const totalOi = this.oiTotalUsd();
      const ref = this.refStream("perp");
      const scale = totalOi && ref?.oiUsd ? totalOi / ref.oiUsd : 1;
      this.liqMap = buildLiqMap(this.series["5m"].bars, price, { scale });
    }
    const last5 = this.series["5m"].last()?.t ?? 0;
    if (last5 !== this.lastAnalogBar && this.series["5m"].bars.length > 200) {
      this.lastAnalogBar = last5;
      refreshAnalogs(this.series["5m"].bars.slice(0, -1), this.analogCache);
    }
  }

  price(): number | null {
    const mids: number[] = [];
    for (const s of this.streams.values()) {
      if (s.state !== "live") continue;
      const m = s.book.valid ? s.book.mid() : null;
      if (m !== null) mids.push(m);
    }
    if (mids.length) return median(mids);
    const r = this.refStream("spot") ?? this.refStream("perp");
    return r?.lastTrade?.price ?? this.series["5m"].last()?.c ?? null;
  }

  private priceSource(): string | null {
    const n = [...this.streams.values()].filter((s) => s.state === "live" && s.book.valid).length;
    if (n) return `median mid of ${n} live book${n > 1 ? "s" : ""}`;
    const r = this.refStream("spot") ?? this.refStream("perp");
    if (r) return `${r.inst.venue} ${r.inst.market} last trade`;
    return this.series["5m"].last() ? "last historical close" : null;
  }

  private venueRows(now: number): VenueRow[] {
    const mids = [...this.streams.values()].filter((s) => s.state === "live" && s.book.valid).map((s) => s.book.mid()!).filter(Boolean);
    const med = mids.length ? median(mids) : null;
    return [...this.streams.values()].map((s) => venueRow(s, now, med)).sort((a, b) => a.venue.localeCompare(b.venue) || a.market.localeCompare(b.market));
  }

  private aggDepth() {
    const rows = this.venueRows(this.now()).filter((r) => r.state === "live" && r.depthBid25Usd !== null);
    if (!rows.length) return null;
    const s = (f: (r: VenueRow) => number | null) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
    return { bid25: s((r) => r.depthBid25Usd), ask25: s((r) => r.depthAsk25Usd), bid100: s((r) => r.depthBid100Usd), ask100: s((r) => r.depthAsk100Usd) };
  }

  /** Live book fragility in [0,1]: aggregate 100bp depth vs its own session history (thin → fragile). */
  private bookFragility(): number | null {
    const h = this.depthHist;
    if (h.length < 60) return null;
    const tot = h.map((x) => x.bid100 + x.ask100);
    const cur = tot[tot.length - 1];
    const sorted = [...tot].sort((a, b) => a - b);
    let below = 0;
    for (const v of sorted) if (v < cur) below++;
    return 1 - below / sorted.length;
  }

  private bookPressure(): BookPressure | null {
    const now = this.now();
    const live = [...this.streams.values()].filter((s) => s.state === "live" && s.book.valid);
    if (!live.length) return null;
    let bidAdd = 0, bidRem = 0, askAdd = 0, askRem = 0;
    let trendSum = 0, trendN = 0;
    for (const s of live) {
      const h = s.churnHist;
      if (h.length < 5) continue;
      let base = h[0];
      for (const x of h) if (x.t >= now - 60_000) { base = x; break; }
      const c = s.book.churn;
      const w = s.book.mid() ?? 1;
      bidAdd += (c.bidAdd - base.bidAdd) * w; bidRem += (c.bidRemove - base.bidRemove) * w;
      askAdd += (c.askAdd - base.askAdd) * w; askRem += (c.askRemove - base.askRemove) * w;
      const ih = s.imbHist;
      if (ih.length > 30) {
        const recent = ih.slice(-15).reduce((a, x) => a + x.v, 0) / 15;
        const prior = ih.slice(-120, -15).reduce((a, x) => a + x.v, 0) / Math.max(1, ih.slice(-120, -15).length);
        trendSum += recent - prior; trendN++;
      }
    }
    return {
      bidReplenish: bidAdd + bidRem > 0 ? bidAdd / (bidAdd + bidRem) : null,
      askReplenish: askAdd + askRem > 0 ? askAdd / (askAdd + askRem) : null,
      imbalanceTrend: trendN ? trendSum / trendN : null,
    };
  }

  private oiTotalUsd(): number | null {
    let s = 0, n = 0;
    for (const x of this.streams.values()) if (x.oiUsd !== null && x.state !== "unavailable") { s += x.oiUsd; n++; }
    return n ? s : null;
  }

  private fundingAvg(): number | null {
    const v: number[] = [];
    for (const x of this.streams.values()) if (x.funding !== null && x.state === "live") v.push(x.funding * (8 / (x.fundingInterval || 8)));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  }

  private heatCursor = 0;

  snapshot(opts: { includeChart: boolean; resetHeat?: boolean }): EngineSnapshot {
    const now = this.now();
    const venues = this.venueRows(now);
    const price = this.price();
    if (opts.resetHeat) this.heatCursor = 0;
    const lastHeatT = this.heatCursor;
    const cols = this.heatCols.filter((c) => c.t > lastHeatT);
    if (cols.length) this.heatCursor = cols[cols.length - 1].t;
    const ago = (ms: number, side: "long" | "short") => this.liqs.filter((l) => l.side === side && now - l.ts <= ms).reduce((a, l) => a + l.usd, 0);
    const d1 = this.series["1d"].bars;
    const b1 = this.bars1m.bars;
    const rets: number[] = [];
    for (let i = Math.max(1, b1.length - 240); i < b1.length; i++) rets.push(Math.log(b1[i].c / b1[i - 1].c));
    let change24h: number | null = null;
    const h1 = this.series["1h"].bars;
    if (price && h1.length > 25) change24h = price / h1[h1.length - 25].c - 1;
    else if (price && d1.length > 1) change24h = price / d1[d1.length - 2].c - 1;
    const anyLiveTrade = [...this.streams.values()].map((s) => s.lastTrade?.recvTs ?? 0);
    return {
      asset: this.asset, mode: this.mode, ts: now, sessionStart: this.sessionStart, price, priceSource: this.priceSource(), priceTs: anyLiveTrade.length ? Math.max(...anyLiveTrade) || null : null, change24h,
      venues, liveVenues: venues.filter((v) => v.state === "live").length, totalStreams: venues.length,
      history: this.history, assessments: this.assessments, bars1m: opts.includeChart ? b1.slice(-360) : [],
      chartBars: opts.includeChart ? Object.fromEntries((["5m", "15m", "1h", "4h", "1d", "1w"] as Timeframe[]).map((tf) => [tf, this.series[tf].bars.slice(-500)])) : {},
      flow: this.flow.slice(-900), venueCvd: [...this.venueCvd.entries()].map(([key, usd]) => ({ key, usd })).sort((a, b) => Math.abs(b.usd) - Math.abs(a.usd)),
      impact: this.impactRes, leadLag: this.leadLag, largeTrades: this.large.tape.slice(0, 40), walls: this.walls.list(now, price), pulledWalls: this.walls.pulled.slice(0, 12),
      liquidations: this.liqs.slice(0, 60), liqTotals: { long5m: ago(300_000, "long"), short5m: ago(300_000, "short"), long1h: ago(3_600_000, "long"), short1h: ago(3_600_000, "short") },
      liqMap: this.liqMap, exhaustion: this.exh, analogs: Object.fromEntries(this.analogCache), opportunities: this.opp.list(), recentOpportunities: this.opp.recent.slice(0, 15), detectors: this.detStatus, audit: this.opp.audit.slice(0, 60),
      heat: { step: this.heatStep ?? 0, cols }, bookPressure: this.bookPressure(), aggDepth: this.aggDepth(), oiTotalUsd: this.oiTotalUsd(), fundingAvg8h: this.fundingAvg(),
      atr1m: atr(b1, 14), atr5m: atr(this.series["5m"].bars, 14), returns1m: rets, eventsPerSec: this.evRate, recording: this.recording, recordedEvents: this.recorded.length,
    };
  }
}

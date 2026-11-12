/**
 * Shared adapter infrastructure: managed WebSockets with backoff+jitter reconnect,
 * stale detection, clock-drift flags, duplicate-trade suppression, REST helper with
 * rate-limit handling, and feed-status bookkeeping (emitted on every state change).
 *
 * Runs in a browser Web Worker (global WebSocket/fetch) or in node tests with injected fakes.
 */
import type {
  AnyEvent,
  Asset,
  BookLevel,
  EventMeta,
  FeedState,
  InstrumentRef,
  QualityFlag,
  TradeEvent,
  Venue,
  VenueAdapter,
} from "../core/types";

export interface WSLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}
export type WSCtor = new (url: string) => WSLike;

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
}
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FetchResponseLike>;

export interface AdapterOptions {
  WebSocketImpl?: WSCtor;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** No message within this window → feed "stale". Default 15s. */
  staleMs?: number;
  /** Reconnect on close. Default true. */
  autoReconnect?: boolean;
  /** Base backoff in ms. Default 500. */
  backoffBaseMs?: number;
  /** Clock drift tolerance in ms. Default 2000. */
  driftToleranceMs?: number;
  /** Disable REST polling loops (tests). */
  disablePolling?: boolean;
  /** Random source for jitter (tests). */
  random?: () => number;
}

export const CLOCK_DRIFT_MS = 2000;

/** Exponential backoff with jitter: base·2^attempt, capped at 30s, scaled by [0.5,1). */
export function backoffDelay(attempt: number, baseMs = 500, rand: () => number = Math.random, capMs = 30_000) {
  const raw = Math.min(capMs, baseMs * 2 ** Math.min(attempt, 16));
  return raw * (0.5 + 0.5 * rand());
}

/** Bounded insertion-ordered set used for duplicate trade-id suppression. */
export class LruSet {
  private s = new Set<string>();
  constructor(readonly capacity = 5000) {}
  /** Returns true if newly added, false if already seen. */
  add(k: string): boolean {
    if (this.s.has(k)) return false;
    this.s.add(k);
    if (this.s.size > this.capacity) {
      const first = this.s.values().next().value as string;
      this.s.delete(first);
    }
    return true;
  }
  get size() {
    return this.s.size;
  }
}

// ---------- CRC32 (IEEE) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC32 of the UTF-8 bytes of `s`, as an unsigned 32-bit integer. */
export function crc32(s: string): number {
  const bytes = new TextEncoder().encode(s);
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** CRC32 as a signed 32-bit integer (OKX, Bitfinex convention). */
export function crc32Signed(s: string): number {
  return crc32(s) | 0;
}

/**
 * Book that keeps venue-original string prices/sizes, needed for checksum venues
 * (OKX, Kraken, Bitfinex) where checksums are computed over the exact wire strings.
 */
export class StringBook {
  bids = new Map<string, string>();
  asks = new Map<string, string>();
  clear() {
    this.bids.clear();
    this.asks.clear();
  }
  set(side: "bid" | "ask", px: string, sz: string, isZero: boolean) {
    const m = side === "bid" ? this.bids : this.asks;
    if (isZero) m.delete(px);
    else m.set(px, sz);
  }
  sorted(side: "bid" | "ask", n = Infinity): [string, string][] {
    const m = side === "bid" ? this.bids : this.asks;
    const arr = [...m.entries()].sort((a, b) => (side === "bid" ? Number(b[0]) - Number(a[0]) : Number(a[0]) - Number(b[0])));
    return n === Infinity ? arr : arr.slice(0, n);
  }
  /** Drop levels beyond `depth` per side (venues like Kraken require local truncation). */
  truncate(depth: number) {
    for (const side of ["bid", "ask"] as const) {
      const keep = this.sorted(side, depth);
      const m = side === "bid" ? this.bids : this.asks;
      if (m.size > depth) {
        m.clear();
        for (const [p, q] of keep) m.set(p, q);
      }
    }
  }
}

// ---------- Managed WebSocket ----------
export interface ManagedSocketOpts {
  url: string | (() => Promise<string>);
  WebSocketImpl: WSCtor;
  onOpen: (sock: ManagedSocket) => void;
  onMessage: (raw: string) => void;
  onState: (state: FeedState, detail?: string) => void;
  /** Called before each reconnect so adapters can reset sync state. */
  onReset?: () => void;
  ping?: { intervalMs: number; payload: () => string };
  staleMs: number;
  now: () => number;
  autoReconnect: boolean;
  backoffBaseMs: number;
  random: () => number;
}

export class ManagedSocket {
  private ws: WSLike | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  lastMsgTs = 0;
  private staleFlagged = false;
  connects = 0;

  constructor(private o: ManagedSocketOpts) {}

  start() {
    this.stopped = false;
    void this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  send(data: unknown) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(typeof data === "string" ? data : JSON.stringify(data));
  }

  get isOpen() {
    return !!this.ws && this.ws.readyState === 1;
  }

  /** Force a reconnect (e.g. unrecoverable gap on a venue whose resync requires a new session). */
  reconnect(detail = "reconnect requested") {
    if (this.stopped) return;
    this.dropSocket();
    this.o.onState("disconnected", detail);
    this.scheduleReconnect();
  }

  private dropSocket() {
    this.clearTimers();
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      ws.onclose = ws.onmessage = ws.onerror = ws.onopen = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private clearTimers() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.reconnectTimer = this.pingTimer = this.staleTimer = null;
  }

  private async connect() {
    if (this.stopped) return;
    this.o.onState("connecting");
    let url: string;
    try {
      url = typeof this.o.url === "string" ? this.o.url : await this.o.url();
    } catch (e) {
      this.o.onState("unavailable", `endpoint resolution failed: ${errMsg(e)}`);
      this.scheduleReconnect();
      return;
    }
    if (this.stopped) return;
    let ws: WSLike;
    try {
      ws = new this.o.WebSocketImpl(url);
    } catch (e) {
      this.o.onState("unavailable", `websocket construct failed: ${errMsg(e)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.connects++;
    ws.onopen = () => {
      this.attempt = 0;
      this.lastMsgTs = this.o.now();
      this.staleFlagged = false;
      this.o.onState("syncing");
      if (this.o.ping) {
        const { intervalMs, payload } = this.o.ping;
        this.pingTimer = setInterval(() => this.send(payload()), intervalMs);
      }
      this.staleTimer = setInterval(() => this.checkStale(), Math.max(20, this.o.staleMs / 2));
      this.o.onOpen(this);
    };
    ws.onmessage = (ev) => {
      this.lastMsgTs = this.o.now();
      if (this.staleFlagged) {
        this.staleFlagged = false;
        this.o.onState("live", "recovered from stale");
      }
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      try {
        this.o.onMessage(raw);
      } catch (e) {
        // A parse error in one message must not kill the feed.
        this.o.onState("live", `message handler error: ${errMsg(e)}`);
      }
    };
    ws.onerror = () => {
      /* onclose follows */
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearTimers();
      if (this.stopped) return;
      this.o.onState("disconnected", "socket closed");
      this.scheduleReconnect();
    };
  }

  private checkStale() {
    const age = this.o.now() - this.lastMsgTs;
    if (age > this.o.staleMs * 3) {
      this.reconnect(`no messages for ${Math.round(age / 1000)}s`);
    } else if (age > this.o.staleMs && !this.staleFlagged) {
      this.staleFlagged = true;
      this.o.onState("stale", `no messages for ${Math.round(age / 1000)}s`);
    }
  }

  private scheduleReconnect() {
    if (this.stopped || !this.o.autoReconnect) return;
    this.o.onReset?.();
    const d = backoffDelay(this.attempt++, this.o.backoffBaseMs, this.o.random);
    this.reconnectTimer = setTimeout(() => void this.connect(), d);
  }
}

export function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

// ---------- Base adapter ----------
export interface FeedKey {
  symbol: string;
  market: InstrumentRef["market"];
}

export abstract class BaseAdapter implements VenueAdapter {
  abstract readonly venue: Venue;
  abstract readonly instruments: InstrumentRef[];
  protected emitFn: (e: AnyEvent) => void = () => {};
  protected running = false;
  protected readonly WS: WSCtor;
  protected readonly fetchFn: FetchLike;
  protected readonly now: () => number;
  protected readonly staleMs: number;
  protected readonly autoReconnect: boolean;
  protected readonly backoffBaseMs: number;
  protected readonly driftMs: number;
  protected readonly polling: boolean;
  protected readonly random: () => number;
  private feedStates = new Map<string, FeedState>();
  private seen = new LruSet(10_000);
  protected sockets: ManagedSocket[] = [];
  protected timers: ReturnType<typeof setInterval>[] = [];
  /** Per-host REST backoff after 429/418. */
  private restBlockedUntil = 0;

  constructor(readonly asset: Asset, opts: AdapterOptions = {}) {
    const g = globalThis as unknown as { WebSocket?: WSCtor; fetch?: FetchLike };
    this.WS = opts.WebSocketImpl ?? (g.WebSocket as WSCtor);
    this.fetchFn = opts.fetchImpl ?? ((u, i) => (g.fetch as FetchLike)(u, i));
    this.now = opts.now ?? (() => Date.now());
    this.staleMs = opts.staleMs ?? 15_000;
    this.autoReconnect = opts.autoReconnect ?? true;
    this.backoffBaseMs = opts.backoffBaseMs ?? 500;
    this.driftMs = opts.driftToleranceMs ?? CLOCK_DRIFT_MS;
    this.polling = !opts.disablePolling;
    this.random = opts.random ?? Math.random;
  }

  start(emit: (e: AnyEvent) => void) {
    if (this.running) return;
    this.emitFn = emit;
    this.running = true;
    if (!this.WS) {
      for (const i of this.instruments) this.status(i, "unavailable", "WebSocket not available in this runtime");
      return;
    }
    this.open();
  }

  stop() {
    this.running = false;
    for (const s of this.sockets) s.stop();
    this.sockets = [];
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.onStop();
  }

  protected abstract open(): void;
  protected onStop() {}

  protected socket(o: Omit<ManagedSocketOpts, "WebSocketImpl" | "staleMs" | "now" | "autoReconnect" | "backoffBaseMs" | "random"> & { staleMs?: number }) {
    const s = new ManagedSocket({
      WebSocketImpl: this.WS,
      now: this.now,
      autoReconnect: this.autoReconnect,
      backoffBaseMs: this.backoffBaseMs,
      random: this.random,
      ...o,
      staleMs: o.staleMs ?? this.staleMs,
    });
    this.sockets.push(s);
    s.start();
    return s;
  }

  protected every(ms: number, fn: () => void, immediate = true) {
    if (!this.polling) return;
    if (immediate) fn();
    this.timers.push(setInterval(fn, ms));
  }

  protected emit(e: AnyEvent) {
    if (this.running) this.emitFn(e);
  }

  /** Emit a feed_status only when the state for (symbol, market) actually changes. */
  protected status(inst: FeedKey, state: FeedState, detail?: string, force = false) {
    const k = `${inst.market}:${inst.symbol}`;
    if (!force && this.feedStates.get(k) === state) return;
    this.feedStates.set(k, state);
    this.emit({ kind: "feed_status", venue: this.venue, symbol: inst.symbol, market: inst.market, state, detail, ts: this.now() });
  }

  protected statusAll(insts: FeedKey[], state: FeedState, detail?: string) {
    for (const i of insts) this.status(i, state, detail);
  }

  feedState(inst: FeedKey) {
    return this.feedStates.get(`${inst.market}:${inst.symbol}`);
  }

  protected meta(inst: InstrumentRef, exchTs: number | null, source: string, extra: QualityFlag[] = []): EventMeta {
    const recvTs = this.now();
    const quality: QualityFlag[] = [...extra];
    if (exchTs !== null && Number.isFinite(exchTs) && Math.abs(recvTs - exchTs) > this.driftMs) quality.push("clock_drift");
    if (!quality.length) quality.push("ok");
    return { inst, exchTs: exchTs !== null && Number.isFinite(exchTs) ? exchTs : null, recvTs, source, quality };
  }

  /** Emit a trade unless its id was already seen (duplicate suppression). Returns whether emitted. */
  protected trade(inst: InstrumentRef, id: string | number, price: number, size: number, side: "buy" | "sell", exchTs: number | null, source: string): boolean {
    if (!(price > 0) || !(size > 0)) return false;
    if (!this.seen.add(`${inst.market}:${inst.symbol}:${id}`)) return false;
    const ev: TradeEvent = { kind: "trade", ...this.meta(inst, exchTs, source), id: String(id), price, size, side };
    this.emit(ev);
    return true;
  }

  protected snapshot(inst: InstrumentRef, bids: BookLevel[], asks: BookLevel[], seq: number | null, exchTs: number | null, source: string, extra: QualityFlag[] = []) {
    bids.sort((a, b) => b[0] - a[0]);
    asks.sort((a, b) => a[0] - b[0]);
    this.emit({ kind: "book_snapshot", ...this.meta(inst, exchTs, source, extra), bids, asks, seq });
  }

  protected delta(inst: InstrumentRef, bids: BookLevel[], asks: BookLevel[], seqFirst: number | null, seqLast: number | null, prevSeq: number | null, exchTs: number | null, source: string) {
    this.emit({ kind: "book_delta", ...this.meta(inst, exchTs, source), bids, asks, seqFirst, seqLast, prevSeq });
  }

  /**
   * GET JSON with rate-limit awareness. 429/418 → back off (Retry-After honored) and
   * report `rate_limited`. Returns null on any failure — callers degrade, never invent.
   */
  protected async getJson<T>(url: string, init?: Parameters<FetchLike>[1]): Promise<{ data: T | null; status: number; error?: string; rateLimited?: boolean }> {
    if (this.now() < this.restBlockedUntil) return { data: null, status: 429, error: "rate limited (backing off)", rateLimited: true };
    try {
      const r = await this.fetchFn(url, init);
      if (r.status === 429 || r.status === 418) {
        const ra = Number(r.headers?.get("retry-after") ?? "");
        this.restBlockedUntil = this.now() + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000);
        return { data: null, status: r.status, error: `HTTP ${r.status} rate limited`, rateLimited: true };
      }
      if (!r.ok) return { data: null, status: r.status, error: `HTTP ${r.status}` };
      return { data: (await r.json()) as T, status: r.status };
    } catch (e) {
      // Browser CORS / geo blocks surface as TypeError: Failed to fetch.
      return { data: null, status: 0, error: errMsg(e) };
    }
  }
}

export function num(x: unknown): number {
  return typeof x === "number" ? x : typeof x === "string" ? Number(x) : NaN;
}

export function lvl(rows: unknown[][] | undefined, mult = 1): BookLevel[] {
  if (!rows) return [];
  const out: BookLevel[] = [];
  for (const r of rows) {
    const p = num(r[0]);
    const q = num(r[1]);
    if (Number.isFinite(p) && Number.isFinite(q)) out.push([p, q * mult]);
  }
  return out;
}

export function parseJson(raw: string): unknown {
  return JSON.parse(raw);
}

/**
 * Bitfinex v2 public WebSocket: spot book (P0, F0, len 100) with checksum (conf flag 131072),
 * trades ("te" executions) and global liquidation feed (status liq:global, filtered to the
 * asset's perpetual F0 contract).
 *
 * Checksum: for i in 0..24 push bid[i] price:amount then ask[i] price:amount (ask amounts are
 * negative), joined with ':', CRC32 signed — computed over JS number→string forms.
 */
import type { Asset, BookLevel, InstrumentRef } from "../core/types";
import { BaseAdapter, StringBook, backoffDelay, crc32Signed, type AdapterOptions, type ManagedSocket } from "./base";

export const BITFINEX_WS = "wss://api-pub.bitfinex.com/ws/2";
const FLAG_CHECKSUM = 131072;

export function bitfinexChecksumString(bids: [string, string][], asks: [string, string][]) {
  const parts: string[] = [];
  for (let i = 0; i < 25; i++) {
    if (bids[i]) parts.push(bids[i][0], bids[i][1]);
    if (asks[i]) parts.push(asks[i][0], asks[i][1]);
  }
  return parts.join(":");
}

export class BitfinexAdapter extends BaseAdapter {
  readonly venue = "bitfinex" as const;
  readonly instruments: InstrumentRef[];
  readonly spot: InstrumentRef;
  readonly perp: InstrumentRef;
  private chans = new Map<number, "book" | "trades" | "liq">();
  private sb = new StringBook();
  private live = false;
  private sock: ManagedSocket | null = null;
  private resyncAttempt = 0;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;
  private bookChan: number | null = null;

  constructor(asset: Asset, opts: AdapterOptions = {}) {
    super(asset, opts);
    this.spot = { venue: "bitfinex", symbol: `t${asset}USD`, asset, market: "spot", contract: "spot", quote: "USD", multiplier: 1 };
    // Perp only used for observed liquidations (USDt-margined F0 contract).
    this.perp = { venue: "bitfinex", symbol: `t${asset}F0:USTF0`, asset, market: "perp", contract: "linear", quote: "USDT", multiplier: 1 };
    this.instruments = [this.spot, this.perp];
  }

  private bookSub() {
    return { event: "subscribe", channel: "book", symbol: this.spot.symbol, prec: "P0", freq: "F0", len: "100" };
  }

  protected open() {
    this.sock = this.socket({
      url: BITFINEX_WS,
      onOpen: (s) => {
        this.chans.clear();
        s.send({ event: "conf", flags: FLAG_CHECKSUM });
        s.send(this.bookSub());
        s.send({ event: "subscribe", channel: "trades", symbol: this.spot.symbol });
        s.send({ event: "subscribe", channel: "status", key: "liq:global" });
      },
      onMessage: (raw) => this.onMessage(raw),
      onState: (st, d) => this.statusAll(this.instruments, st, d),
      onReset: () => {
        this.sb.clear();
        this.live = false;
      },
    });
  }

  protected onStop() {
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
  }

  private onMessage(raw: string) {
    const m = JSON.parse(raw) as unknown;
    if (!Array.isArray(m)) {
      const e = m as { event: string; channel?: string; chanId?: number; key?: string; msg?: string };
      if (e.event === "subscribed" && e.chanId !== undefined) {
        const kind = e.channel === "book" ? "book" : e.channel === "trades" ? "trades" : "liq";
        this.chans.set(e.chanId, kind);
        if (kind === "book") this.bookChan = e.chanId;
      } else if (e.event === "unsubscribed" && e.chanId !== undefined) {
        this.chans.delete(e.chanId);
      } else if (e.event === "error") {
        this.status(this.spot, "unavailable", `bitfinex error: ${e.msg}`);
      } else if (e.event === "info" && (e as { code?: number }).code === 20051) {
        this.sock?.reconnect("venue requested reconnect");
      }
      return;
    }
    const [chanId, payload, extra] = m as [number, unknown, unknown];
    const kind = this.chans.get(chanId);
    if (!kind || payload === "hb") return;
    if (kind === "book") {
      if (payload === "cs") return this.onChecksum(extra as number);
      const rows = payload as number[] | number[][];
      if (Array.isArray(rows[0])) this.onBookSnapshot(rows as number[][]);
      else if (this.live) this.onBookUpdate(rows as number[]);
    } else if (kind === "trades") {
      if (payload === "te") {
        const [id, mts, amount, price] = extra as number[];
        // AMOUNT > 0: buyer was the aggressor.
        this.trade(this.spot, id, price, Math.abs(amount), amount > 0 ? "buy" : "sell", mts, "bitfinex.ws.trades");
      }
      // Initial snapshot (array) is historical — skipped to avoid backfilling live CVD; "tu" duplicates "te".
    } else if (kind === "liq") {
      for (const r of (payload as unknown[][]) ?? []) {
        if (!Array.isArray(r) || r[0] !== "pos" || r[4] !== this.perp.symbol) continue;
        const mts = r[2] as number;
        if (this.now() - mts > 60_000) continue; // ignore historical backlog
        const amount = r[5] as number;
        const price = (r[11] as number) || (r[6] as number);
        if (!(price > 0) || !amount) continue;
        this.emit({ kind: "liquidation", ...this.meta(this.perp, mts, "bitfinex.ws.status.liq"), price, size: Math.abs(amount), positionSide: amount > 0 ? "long" : "short" });
      }
    }
  }

  private setRow(price: number, count: number, amount: number): BookLevel & { side?: "bid" | "ask" } {
    const side = amount > 0 ? "bid" : "ask";
    const key = String(price);
    this.sb.set(side, key, String(amount), count === 0);
    return [price, count === 0 ? 0 : Math.abs(amount)];
  }

  private onBookSnapshot(rows: number[][]) {
    this.sb.clear();
    const bids: BookLevel[] = [], asks: BookLevel[] = [];
    for (const [p, c, a] of rows) (a > 0 ? bids : asks).push(this.setRow(p, c, a));
    const was = this.resyncAttempt > 0;
    this.live = true;
    this.snapshot(this.spot, bids, asks, null, null, "bitfinex.ws.book.snapshot", was ? ["resynced"] : []);
    this.status(this.spot, "live");
  }

  private onBookUpdate([p, c, a]: number[]) {
    // count=0 deletes: amount sign (1 / -1) selects side.
    const l = this.setRow(p, c, a);
    if (a > 0) this.delta(this.spot, [l], [], null, null, null, null, "bitfinex.ws.book.update");
    else this.delta(this.spot, [], [l], null, null, null, null, "bitfinex.ws.book.update");
  }

  private onChecksum(cs: number) {
    if (!this.live) return;
    const s = bitfinexChecksumString(this.sb.sorted("bid", 25), this.sb.sorted("ask", 25));
    if (crc32Signed(s) === cs) {
      this.resyncAttempt = 0;
      return;
    }
    this.live = false;
    this.sb.clear();
    this.status(this.spot, "gap_recovering", "checksum mismatch");
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    const delay = backoffDelay(this.resyncAttempt++, this.backoffBaseMs, this.random);
    this.resyncTimer = setTimeout(() => {
      if (!this.running || !this.sock) return;
      if (this.bookChan !== null) this.sock.send({ event: "unsubscribe", chanId: this.bookChan });
      this.sock.send(this.bookSub());
    }, delay);
  }
}

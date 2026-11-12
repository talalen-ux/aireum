/**
 * Kraken WebSocket v2 (BTC/USD spot): `book` with CRC32 checksum + `trade`.
 *
 * Checksum (v2): top 10 asks (ascending) then top 10 bids (descending); for each level the
 * price and qty are formatted to the pair's precision, '.' removed and leading zeros stripped,
 * concatenated; CRC32 (unsigned) of the whole string must equal `checksum`.
 * Kraken requires the client to truncate its book to the subscribed depth after each update.
 * Mismatch → gap → resubscribe for a fresh snapshot.
 */
import type { Asset, BookLevel, InstrumentRef } from "../core/types";
import { BaseAdapter, StringBook, backoffDelay, crc32, num, type AdapterOptions, type ManagedSocket } from "./base";

export const KRAKEN_WS = "wss://ws.kraken.com/v2";
export const KRAKEN_PRECISION: Record<Asset, { price: number; qty: number }> = { BTC: { price: 1, qty: 8 }, ETH: { price: 2, qty: 8 } };
const DEPTH = 500;

function ckPart(s: string) {
  return s.replace(".", "").replace(/^0+/, "");
}

export function krakenChecksumString(asks: [string, string][], bids: [string, string][]): string {
  let s = "";
  for (const [p, q] of asks.slice(0, 10)) s += ckPart(p) + ckPart(q);
  for (const [p, q] of bids.slice(0, 10)) s += ckPart(p) + ckPart(q);
  return s;
}
export function krakenChecksum(asks: [string, string][], bids: [string, string][]) {
  return crc32(krakenChecksumString(asks, bids));
}

export class KrakenAdapter extends BaseAdapter {
  readonly venue = "kraken" as const;
  readonly instruments: InstrumentRef[];
  readonly spot: InstrumentRef;
  private sb = new StringBook();
  private live = false;
  private sock: ManagedSocket | null = null;
  private resyncAttempt = 0;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(asset: Asset, opts: AdapterOptions = {}) {
    super(asset, opts);
    this.spot = { venue: "kraken", symbol: `${asset}/USD`, asset, market: "spot", contract: "spot", quote: "USD", multiplier: 1 };
    this.instruments = [this.spot];
  }

  protected open() {
    this.sock = this.socket({
      url: KRAKEN_WS,
      onOpen: (s) => {
        s.send({ method: "subscribe", params: { channel: "book", symbol: [this.spot.symbol], depth: DEPTH } });
        s.send({ method: "subscribe", params: { channel: "trade", symbol: [this.spot.symbol], snapshot: false } });
      },
      onMessage: (raw) => this.onMessage(raw),
      onState: (st, d) => this.status(this.spot, st, d),
      onReset: () => {
        this.sb.clear();
        this.live = false;
      },
      ping: { intervalMs: 30_000, payload: () => JSON.stringify({ method: "ping" }) },
    });
  }

  protected onStop() {
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
  }

  private fmt(x: number, kind: "price" | "qty") {
    return x.toFixed(KRAKEN_PRECISION[this.asset][kind]);
  }

  private onMessage(raw: string) {
    const m = JSON.parse(raw) as { channel?: string; type?: string; method?: string; success?: boolean; error?: string; data?: Record<string, unknown>[] };
    if (m.method === "subscribe" && m.success === false) {
      this.status(this.spot, "unavailable", `subscribe rejected: ${m.error}`);
      return;
    }
    if (m.channel === "book" && m.data) {
      for (const d of m.data) this.onBook(m.type ?? "update", d);
    } else if (m.channel === "trade" && m.data) {
      for (const t of m.data) {
        // Kraken reports the taker side.
        this.trade(this.spot, String(t.trade_id), num(t.price), num(t.qty), t.side === "buy" ? "buy" : "sell", Date.parse(String(t.timestamp)), "kraken.ws.v2.trade");
      }
    }
  }

  private onBook(type: string, d: Record<string, unknown>) {
    const bidsRaw = (d.bids as { price: number; qty: number }[]) ?? [];
    const asksRaw = (d.asks as { price: number; qty: number }[]) ?? [];
    const ts = d.timestamp ? Date.parse(String(d.timestamp)) : null;
    const apply = (side: "bid" | "ask", rows: { price: number; qty: number }[]) => {
      const out: BookLevel[] = [];
      for (const r of rows) {
        const p = num(r.price), q = num(r.qty);
        this.sb.set(side, this.fmt(p, "price"), this.fmt(q, "qty"), q === 0);
        out.push([p, q]);
      }
      return out;
    };
    if (type === "snapshot") {
      this.sb.clear();
      const bids = apply("bid", bidsRaw);
      const asks = apply("ask", asksRaw);
      if (!this.verify(d.checksum)) return this.gap("snapshot checksum mismatch");
      const was = this.resyncAttempt > 0;
      this.live = true;
      this.resyncAttempt = 0;
      this.snapshot(this.spot, bids, asks, null, ts, "kraken.ws.v2.book.snapshot", was ? ["resynced"] : []);
      this.status(this.spot, "live");
      return;
    }
    if (!this.live) return;
    const bids = apply("bid", bidsRaw);
    const asks = apply("ask", asksRaw);
    // Truncate to subscribed depth; emit removals for the dropped levels so the engine book matches.
    const beforeB = new Set(this.sb.bids.keys());
    const beforeA = new Set(this.sb.asks.keys());
    this.sb.truncate(DEPTH);
    for (const p of beforeB) if (!this.sb.bids.has(p)) bids.push([Number(p), 0]);
    for (const p of beforeA) if (!this.sb.asks.has(p)) asks.push([Number(p), 0]);
    if (!this.verify(d.checksum)) return this.gap("checksum mismatch");
    this.delta(this.spot, bids, asks, null, null, null, ts, "kraken.ws.v2.book.update");
  }

  private verify(checksum: unknown) {
    if (checksum === undefined || checksum === null) return true;
    return krakenChecksum(this.sb.sorted("ask", 10), this.sb.sorted("bid", 10)) === num(checksum);
  }

  private gap(detail: string) {
    this.live = false;
    this.sb.clear();
    this.status(this.spot, "gap_recovering", detail);
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    const delay = backoffDelay(this.resyncAttempt++, this.backoffBaseMs, this.random);
    this.resyncTimer = setTimeout(() => {
      if (!this.running || !this.sock) return;
      this.sock.send({ method: "unsubscribe", params: { channel: "book", symbol: [this.spot.symbol], depth: DEPTH } });
      this.sock.send({ method: "subscribe", params: { channel: "book", symbol: [this.spot.symbol], depth: DEPTH } });
    }, delay);
  }
}

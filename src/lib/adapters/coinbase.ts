/**
 * Coinbase Advanced Trade public WebSocket (BTC-USD spot).
 *
 * `sequence_num` increases by exactly 1 per message on a connection (across all channels on
 * that connection). Level2 runs on its own connection with heartbeats so any skipped number
 * means a missed book update → gap → reconnect (fresh snapshot). Trades run separately.
 */
import type { Asset, BookLevel, InstrumentRef } from "../core/types";
import { BaseAdapter, num, type AdapterOptions } from "./base";

export const COINBASE_WS = "wss://advanced-trade-ws.coinbase.com";

interface L2Update {
  side: "bid" | "offer";
  event_time: string;
  price_level: string;
  new_quantity: string;
}

export class CoinbaseAdapter extends BaseAdapter {
  readonly venue = "coinbase" as const;
  readonly instruments: InstrumentRef[];
  readonly spot: InstrumentRef;
  private bookSeq: number | null = null;
  private haveSnap = false;

  constructor(asset: Asset, opts: AdapterOptions = {}) {
    super(asset, opts);
    this.spot = { venue: "coinbase", symbol: `${asset}-USD`, asset, market: "spot", contract: "spot", quote: "USD", multiplier: 1 };
    this.instruments = [this.spot];
  }

  protected open() {
    const pid = this.spot.symbol;
    const book = this.socket({
      url: COINBASE_WS,
      onOpen: (s) => {
        this.bookSeq = null;
        this.haveSnap = false;
        s.send({ type: "subscribe", product_ids: [pid], channel: "level2" });
        s.send({ type: "subscribe", channel: "heartbeats" });
      },
      onMessage: (raw) => {
        const m = JSON.parse(raw) as { channel: string; sequence_num?: number; timestamp?: string; events?: { type: string; product_id?: string; updates?: L2Update[] }[] };
        if (typeof m.sequence_num === "number") {
          if (this.bookSeq !== null && m.sequence_num !== this.bookSeq + 1) {
            this.status(this.spot, "gap_recovering", `sequence_num ${m.sequence_num} after ${this.bookSeq}`);
            this.bookSeq = null;
            this.haveSnap = false;
            book.reconnect("level2 sequence gap");
            return;
          }
          this.bookSeq = m.sequence_num;
        }
        if (m.channel !== "l2_data" || !m.events) return;
        const ts = m.timestamp ? Date.parse(m.timestamp) : null;
        for (const ev of m.events) {
          if (ev.product_id && ev.product_id !== pid) continue;
          const bids: BookLevel[] = [];
          const asks: BookLevel[] = [];
          for (const u of ev.updates ?? []) {
            const l: BookLevel = [num(u.price_level), num(u.new_quantity)];
            if (!Number.isFinite(l[0]) || !Number.isFinite(l[1])) continue;
            (u.side === "bid" ? bids : asks).push(l);
          }
          if (ev.type === "snapshot") {
            const was = this.haveSnap;
            this.haveSnap = true;
            this.snapshot(this.spot, bids, asks, null, ts, "coinbase.adv.ws.level2.snapshot", was ? ["resynced"] : []);
            this.status(this.spot, "live");
          } else if (this.haveSnap) {
            this.delta(this.spot, bids, asks, null, null, null, ts, "coinbase.adv.ws.level2.update");
          }
        }
      },
      onState: (st, d) => this.status(this.spot, st, d),
      onReset: () => {
        this.bookSeq = null;
        this.haveSnap = false;
      },
    });
    this.socket({
      url: COINBASE_WS,
      onOpen: (s) => s.send({ type: "subscribe", product_ids: [pid], channel: "market_trades" }),
      onMessage: (raw) => {
        const m = JSON.parse(raw) as { channel: string; events?: { type: string; trades?: { trade_id: string; product_id: string; price: string; size: string; side: string; time: string }[] }[] };
        if (m.channel !== "market_trades") return;
        for (const ev of m.events ?? []) {
          // Skip the initial "snapshot" batch of historical trades: replaying them would distort live CVD.
          if (ev.type === "snapshot") continue;
          for (const t of ev.trades ?? []) {
            if (t.product_id !== pid) continue;
            // Advanced Trade reports the taker side (BUY = aggressive buyer).
            this.trade(this.spot, t.trade_id, num(t.price), num(t.size), t.side === "BUY" ? "buy" : "sell", Date.parse(t.time), "coinbase.adv.ws.market_trades");
          }
        }
      },
      // Trades socket state is not the book's state; only surface hard failures.
      onState: (st, d) => {
        if (st === "unavailable") this.status(this.spot, st, `trades: ${d}`);
      },
    });
  }
}

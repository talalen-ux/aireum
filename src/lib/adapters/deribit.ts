/**
 * Deribit inverse perpetual (BTC-PERPETUAL / ETH-PERPETUAL), JSON-RPC over WebSocket.
 *
 * Book: `book.<inst>.100ms` — snapshot then changes chained by prev_change_id == last change_id.
 * Break → gap → unsubscribe/resubscribe (venue re-sends a snapshot).
 * Amounts on inverse instruments are USD notional; converted to BASE units by dividing by price.
 * Trades carry a `liquidation` flag (M = maker, T = taker, MT = both) → observed liquidations.
 */
import type { Asset, BookLevel, InstrumentRef } from "../core/types";
import { BaseAdapter, backoffDelay, num, type AdapterOptions, type ManagedSocket } from "./base";

export const DERIBIT_WS = "wss://www.deribit.com/ws/api/v2";
const CONTRACT_USD: Record<Asset, number> = { BTC: 10, ETH: 1 };

type DLevel = ["new" | "change" | "delete", number, number];

export class DeribitAdapter extends BaseAdapter {
  readonly venue = "deribit" as const;
  readonly instruments: InstrumentRef[];
  readonly perp: InstrumentRef;
  private changeId: number | null = null;
  private live = false;
  private sock: ManagedSocket | null = null;
  private rpcId = 1;
  private resyncAttempt = 0;
  private resyncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(asset: Asset, opts: AdapterOptions = {}) {
    super(asset, opts);
    this.perp = { venue: "deribit", symbol: `${asset}-PERPETUAL`, asset, market: "perp", contract: "inverse", quote: "USD", multiplier: CONTRACT_USD[asset] };
    this.instruments = [this.perp];
  }

  private get ch() {
    const i = this.perp.symbol;
    return { book: `book.${i}.100ms`, trades: `trades.${i}.100ms`, ticker: `ticker.${i}.100ms` };
  }

  private rpc(method: string, params: Record<string, unknown>) {
    this.sock?.send({ jsonrpc: "2.0", id: this.rpcId++, method, params });
  }

  protected open() {
    this.sock = this.socket({
      url: DERIBIT_WS,
      onOpen: () => {
        this.rpc("public/set_heartbeat", { interval: 30 });
        this.rpc("public/subscribe", { channels: [this.ch.book, this.ch.trades, this.ch.ticker] });
      },
      onMessage: (raw) => this.onMessage(raw),
      onState: (st, d) => this.status(this.perp, st, d),
      onReset: () => {
        this.changeId = null;
        this.live = false;
      },
    });
  }

  protected onStop() {
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
  }

  private onMessage(raw: string) {
    const m = JSON.parse(raw) as { method?: string; params?: { type?: string; channel?: string; data?: unknown }; error?: { message: string } };
    if (m.error) {
      this.status(this.perp, "unavailable", `deribit error: ${m.error.message}`);
      return;
    }
    if (m.method === "heartbeat") {
      if (m.params?.type === "test_request") this.rpc("public/test", {});
      return;
    }
    if (m.method !== "subscription" || !m.params?.channel) return;
    const { channel, data } = m.params;
    if (channel === this.ch.book) this.onBook(data as BookMsg);
    else if (channel === this.ch.trades) this.onTrades(data as TradeMsg[]);
    else if (channel === this.ch.ticker) this.onTicker(data as Record<string, unknown>);
  }

  private toLevels(rows: DLevel[]): BookLevel[] {
    // amount is USD notional for inverse contracts → base = usd / price
    return rows.map(([act, p, usd]) => [p, act === "delete" ? 0 : usd / p] as BookLevel);
  }

  private onBook(d: BookMsg) {
    if (d.type === "snapshot") {
      const was = this.resyncAttempt > 0 || this.changeId !== null;
      this.changeId = d.change_id;
      this.live = true;
      this.resyncAttempt = 0;
      this.snapshot(this.perp, this.toLevels(d.bids), this.toLevels(d.asks), d.change_id, d.timestamp, "deribit.ws.book.snapshot", was ? ["resynced"] : []);
      this.status(this.perp, "live");
      return;
    }
    if (!this.live) return;
    if (d.prev_change_id !== this.changeId) return this.gap(`prev_change_id=${d.prev_change_id} != last change_id=${this.changeId}`);
    const prev = this.changeId;
    this.changeId = d.change_id;
    this.delta(this.perp, this.toLevels(d.bids), this.toLevels(d.asks), d.change_id, d.change_id, prev, d.timestamp, "deribit.ws.book.change");
  }

  private gap(detail: string) {
    this.live = false;
    this.changeId = null;
    this.status(this.perp, "gap_recovering", detail);
    if (this.resyncTimer) clearTimeout(this.resyncTimer);
    const delay = backoffDelay(this.resyncAttempt++, this.backoffBaseMs, this.random);
    this.resyncTimer = setTimeout(() => {
      if (!this.running) return;
      this.rpc("public/unsubscribe", { channels: [this.ch.book] });
      this.rpc("public/subscribe", { channels: [this.ch.book] });
    }, delay);
  }

  private onTrades(ts: TradeMsg[]) {
    for (const t of ts) {
      const base = t.amount / t.price;
      this.trade(this.perp, t.trade_id, t.price, base, t.direction, t.timestamp, "deribit.ws.trades");
      if (t.liquidation) {
        // direction is the taker's side. Taker liquidated + sell → a long was closed.
        // Maker liquidated: maker took the opposite side → sell taker means maker bought → short closed.
        if (t.liquidation.includes("T"))
          this.emit({ kind: "liquidation", ...this.meta(this.perp, t.timestamp, "deribit.ws.trades.liquidation"), price: t.price, size: base, positionSide: t.direction === "sell" ? "long" : "short" });
        if (t.liquidation.includes("M"))
          this.emit({ kind: "liquidation", ...this.meta(this.perp, t.timestamp, "deribit.ws.trades.liquidation"), price: t.price, size: base, positionSide: t.direction === "sell" ? "short" : "long" });
      }
    }
  }

  private onTicker(d: Record<string, unknown>) {
    const ts = num(d.timestamp);
    const mark = num(d.mark_price), index = num(d.index_price), last = num(d.last_price);
    this.emit({ kind: "mark_index", ...this.meta(this.perp, ts, "deribit.ws.ticker"), mark: fin(mark), index: fin(index), last: fin(last) });
    const oiUsd = num(d.open_interest); // USD for inverse perpetuals
    if (Number.isFinite(oiUsd) && mark > 0) this.emit({ kind: "open_interest", ...this.meta(this.perp, ts, "deribit.ws.ticker"), oiBase: oiUsd / mark, oiUsd });
    const f8 = num(d.funding_8h);
    // Deribit funds continuously; funding_8h is the 8h-equivalent rate.
    if (Number.isFinite(f8)) this.emit({ kind: "funding", ...this.meta(this.perp, ts, "deribit.ws.ticker"), rate: f8, intervalHours: 8, nextFundingTs: null });
  }
}

interface BookMsg {
  type: "snapshot" | "change";
  timestamp: number;
  change_id: number;
  prev_change_id?: number;
  bids: DLevel[];
  asks: DLevel[];
}
interface TradeMsg {
  trade_id: string;
  price: number;
  amount: number;
  direction: "buy" | "sell";
  timestamp: number;
  liquidation?: "M" | "T" | "MT";
}

function fin(x: number) {
  return Number.isFinite(x) ? x : null;
}

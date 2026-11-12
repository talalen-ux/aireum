/**
 * KuCoin spot. Public WS access requires a token from POST /api/v1/bullet-public. Browsers
 * are frequently blocked by CORS on that endpoint; when it fails the feed is reported as
 * "unavailable" with the reason — never substituted with fabricated data.
 *
 * Book: /spotMarket/level2Depth50 pushes full top-50 snapshots (~100ms), emitted as
 * book_snapshot (no incremental sequencing needed). Trades: /market/match.
 */
import type { Asset, InstrumentRef } from "../core/types";
import { BaseAdapter, num, type AdapterOptions } from "./base";

export const KUCOIN_REST = "https://api.kucoin.com";

interface Bullet {
  code: string;
  data: { token: string; instanceServers: { endpoint: string; pingInterval: number; protocol: string }[] };
}

export class KucoinAdapter extends BaseAdapter {
  readonly venue = "kucoin" as const;
  readonly instruments: InstrumentRef[];
  readonly spot: InstrumentRef;
  private pingMs = 18_000;
  private rid = 1;

  constructor(asset: Asset, opts: AdapterOptions = {}) {
    super(asset, opts);
    this.spot = { venue: "kucoin", symbol: `${asset}-USDT`, asset, market: "spot", contract: "spot", quote: "USDT", multiplier: 1 };
    this.instruments = [this.spot];
  }

  /** Resolve a tokenized endpoint; throws (→ "unavailable") when the bullet call fails. */
  private async endpoint(): Promise<string> {
    const r = await this.getJson<Bullet>(`${KUCOIN_REST}/api/v1/bullet-public`, { method: "POST" });
    if (!r.data || r.data.code !== "200000" || !r.data.data.instanceServers.length)
      throw new Error(`bullet-public token request failed (${r.error ?? r.data?.code ?? "no servers"}); likely CORS-blocked in browsers — route via a server-side proxy`);
    const srv = r.data.data.instanceServers[0];
    this.pingMs = Math.max(5_000, srv.pingInterval || 18_000);
    return `${srv.endpoint}?token=${encodeURIComponent(r.data.data.token)}&connectId=atlas${Math.floor(this.random() * 1e9)}`;
  }

  protected open() {
    const sym = this.spot.symbol;
    this.socket({
      url: () => this.endpoint(),
      onOpen: (s) => {
        s.send({ id: String(this.rid++), type: "subscribe", topic: `/spotMarket/level2Depth50:${sym}`, privateChannel: false, response: true });
        s.send({ id: String(this.rid++), type: "subscribe", topic: `/market/match:${sym}`, privateChannel: false, response: true });
      },
      onMessage: (raw) => this.onMessage(raw),
      onState: (st, d) => this.status(this.spot, st, d),
      ping: { intervalMs: this.pingMs, payload: () => JSON.stringify({ id: String(this.rid++), type: "ping" }) },
    });
  }

  private onMessage(raw: string) {
    const m = JSON.parse(raw) as { type: string; topic?: string; data?: Record<string, unknown> };
    if (m.type !== "message" || !m.topic || !m.data) return;
    if (m.topic.startsWith("/spotMarket/level2Depth50:")) {
      const d = m.data as { asks: [string, string][]; bids: [string, string][]; timestamp: number };
      this.snapshot(this.spot, d.bids.map((r) => [num(r[0]), num(r[1])]), d.asks.map((r) => [num(r[0]), num(r[1])]), null, d.timestamp ?? null, "kucoin.ws.level2Depth50");
      this.status(this.spot, "live");
    } else if (m.topic.startsWith("/market/match:")) {
      const d = m.data as { tradeId: string; price: string; size: string; side: "buy" | "sell"; time: string };
      // `side` is the taker side; `time` is nanoseconds.
      this.trade(this.spot, d.tradeId, num(d.price), num(d.size), d.side, Math.floor(num(d.time) / 1e6), "kucoin.ws.match");
    }
  }
}

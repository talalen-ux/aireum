/**
 * Hyperliquid perpetuals (USDC-margined, linear). l2Book pushes full top-of-book snapshots
 * (≈20 levels/side) on every change, so each message is emitted as a book_snapshot — no
 * incremental sequencing is required. activeAssetCtx carries hourly funding, OI (coins),
 * mark and oracle prices.
 */
import type { Asset, InstrumentRef } from "../core/types";
import { BaseAdapter, num, type AdapterOptions } from "./base";

export const HYPERLIQUID_WS = "wss://api.hyperliquid.xyz/ws";

export class HyperliquidAdapter extends BaseAdapter {
  readonly venue = "hyperliquid" as const;
  readonly instruments: InstrumentRef[];
  readonly perp: InstrumentRef;

  constructor(asset: Asset, opts: AdapterOptions = {}) {
    super(asset, opts);
    this.perp = { venue: "hyperliquid", symbol: asset, asset, market: "perp", contract: "linear", quote: "USDC", multiplier: 1 };
    this.instruments = [this.perp];
  }

  protected open() {
    const coin = this.perp.symbol;
    this.socket({
      url: HYPERLIQUID_WS,
      onOpen: (s) => {
        for (const type of ["l2Book", "trades", "activeAssetCtx"]) s.send({ method: "subscribe", subscription: { type, coin } });
      },
      onMessage: (raw) => this.onMessage(raw),
      onState: (st, d) => this.status(this.perp, st, d),
      ping: { intervalMs: 50_000, payload: () => JSON.stringify({ method: "ping" }) },
    });
  }

  private onMessage(raw: string) {
    const m = JSON.parse(raw) as { channel: string; data: unknown };
    const coin = this.perp.symbol;
    if (m.channel === "l2Book") {
      const d = m.data as { coin: string; time: number; levels: [{ px: string; sz: string; n: number }[], { px: string; sz: string; n: number }[]] };
      if (d.coin !== coin) return;
      const bids = d.levels[0].map((l) => [num(l.px), num(l.sz)] as [number, number]);
      const asks = d.levels[1].map((l) => [num(l.px), num(l.sz)] as [number, number]);
      this.snapshot(this.perp, bids, asks, null, d.time, "hyperliquid.ws.l2Book");
      this.status(this.perp, "live");
    } else if (m.channel === "trades") {
      for (const t of m.data as { coin: string; side: "A" | "B"; px: string; sz: string; time: number; tid: number; hash: string }[]) {
        if (t.coin !== coin) continue;
        // side "B": the aggressor bought (took the ask).
        this.trade(this.perp, t.tid, num(t.px), num(t.sz), t.side === "B" ? "buy" : "sell", t.time, "hyperliquid.ws.trades");
      }
    } else if (m.channel === "activeAssetCtx") {
      const d = m.data as { coin: string; ctx: { funding: string; openInterest: string; markPx: string; oraclePx: string; midPx?: string } };
      if (d.coin !== coin) return;
      const mark = num(d.ctx.markPx);
      const oracle = num(d.ctx.oraclePx);
      const oiBase = num(d.ctx.openInterest);
      const rate = num(d.ctx.funding);
      // activeAssetCtx carries no venue timestamp.
      this.emit({ kind: "mark_index", ...this.meta(this.perp, null, "hyperliquid.ws.activeAssetCtx"), mark: fin(mark), index: fin(oracle), last: fin(num(d.ctx.midPx)) });
      if (Number.isFinite(oiBase) && Number.isFinite(mark)) this.emit({ kind: "open_interest", ...this.meta(this.perp, null, "hyperliquid.ws.activeAssetCtx"), oiBase, oiUsd: oiBase * mark });
      if (Number.isFinite(rate)) {
        const now = this.now();
        this.emit({ kind: "funding", ...this.meta(this.perp, null, "hyperliquid.ws.activeAssetCtx"), rate, intervalHours: 1, nextFundingTs: Math.ceil(now / 3_600_000) * 3_600_000 });
      }
    }
  }
}

function fin(x: number) {
  return Number.isFinite(x) ? x : null;
}

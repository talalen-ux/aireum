/**
 * OKX v5 public: spot (BTC-USDT) and USDT-margined swap (BTC-USDT-SWAP).
 *
 * `books` (400 levels): snapshot then updates chained by prevSeqId == previous seqId,
 * plus a CRC32 checksum over the top 25 levels of the *wire strings*. Either a seq break
 * or a checksum mismatch → gap → unsubscribe/resubscribe for a fresh snapshot.
 * Swap sizes are in contracts: ctVal = 0.01 BTC / 0.1 ETH per contract.
 */
import type { Asset, InstrumentRef } from "../core/types";
import { BaseAdapter, StringBook, backoffDelay, crc32Signed, num, type AdapterOptions, type ManagedSocket } from "./base";

export const OKX_WS = "wss://ws.okx.com:8443/ws/v5/public";
export const OKX_CT_VAL: Record<Asset, number> = { BTC: 0.01, ETH: 0.1 };

type Row = [string, string, string?, string?];

/** OKX checksum: interleave top-25 bid/ask "px:sz" pairs (bid first), join with ':', CRC32 signed. */
export function okxChecksumString(bids: [string, string][], asks: [string, string][]): string {
  const parts: string[] = [];
  for (let i = 0; i < 25; i++) {
    if (i < bids.length) parts.push(`${bids[i][0]}:${bids[i][1]}`);
    if (i < asks.length) parts.push(`${asks[i][0]}:${asks[i][1]}`);
  }
  return parts.join(":");
}
export function okxChecksum(bids: [string, string][], asks: [string, string][]) {
  return crc32Signed(okxChecksumString(bids, asks));
}

interface BookState {
  sb: StringBook;
  seq: number | null;
  live: boolean;
  resyncAttempt: number;
  resyncTimer: ReturnType<typeof setTimeout> | null;
}

export class OkxAdapter extends BaseAdapter {
  readonly venue = "okx" as const;
  readonly instruments: InstrumentRef[];
  readonly spot: InstrumentRef;
  readonly perp: InstrumentRef;
  private books = new Map<string, BookState>();
  private sock: ManagedSocket | null = null;
  private mark: number | null = null;
  private index: number | null = null;
  private last: number | null = null;

  constructor(asset: Asset, opts: AdapterOptions = {}) {
    super(asset, opts);
    this.spot = { venue: "okx", symbol: `${asset}-USDT`, asset, market: "spot", contract: "spot", quote: "USDT", multiplier: 1 };
    this.perp = { venue: "okx", symbol: `${asset}-USDT-SWAP`, asset, market: "perp", contract: "linear", quote: "USDT", multiplier: OKX_CT_VAL[asset] };
    this.instruments = [this.spot, this.perp];
    for (const i of this.instruments) this.books.set(i.symbol, { sb: new StringBook(), seq: null, live: false, resyncAttempt: 0, resyncTimer: null });
  }

  private inst(instId: string) {
    return this.instruments.find((i) => i.symbol === instId);
  }

  protected open() {
    const args = [
      ...this.instruments.flatMap((i) => [
        { channel: "books", instId: i.symbol },
        { channel: "trades", instId: i.symbol },
      ]),
      { channel: "liquidation-orders", instType: "SWAP" },
      { channel: "open-interest", instId: this.perp.symbol },
      { channel: "funding-rate", instId: this.perp.symbol },
      { channel: "mark-price", instId: this.perp.symbol },
      { channel: "index-tickers", instId: `${this.asset}-USDT` },
    ];
    this.sock = this.socket({
      url: OKX_WS,
      onOpen: (s) => s.send({ op: "subscribe", args }),
      onMessage: (raw) => this.onMessage(raw),
      onState: (st, d) => this.statusAll(this.instruments, st, d),
      onReset: () => {
        for (const b of this.books.values()) {
          b.sb.clear();
          b.seq = null;
          b.live = false;
        }
      },
      ping: { intervalMs: 20_000, payload: () => "ping" },
    });
  }

  protected onStop() {
    for (const b of this.books.values()) if (b.resyncTimer) clearTimeout(b.resyncTimer);
  }

  private onMessage(raw: string) {
    if (raw === "pong") return;
    const m = JSON.parse(raw) as { event?: string; msg?: string; arg?: { channel: string; instId?: string }; action?: string; data?: Record<string, unknown>[] };
    if (m.event) {
      if (m.event === "error") this.statusAll(this.instruments, "unavailable", `okx error: ${m.msg}`);
      return;
    }
    if (!m.arg || !m.data) return;
    const ch = m.arg.channel;
    if (ch === "books") return this.onBook(m.arg.instId!, m.action ?? "update", m.data[0]);
    if (ch === "trades") {
      const inst = this.inst(m.arg.instId!);
      if (!inst) return;
      for (const t of m.data) {
        const px = num(t.px);
        if (inst.market === "perp") this.last = px;
        this.trade(inst, t.tradeId as string, px, num(t.sz) * inst.multiplier, t.side === "buy" ? "buy" : "sell", num(t.ts), `okx.ws.trades`);
      }
      return;
    }
    if (ch === "liquidation-orders") {
      for (const d of m.data) {
        if (d.instId !== this.perp.symbol) continue;
        for (const x of (d.details as Record<string, unknown>[]) ?? []) {
          const price = num(x.bkPx), size = num(x.sz) * this.perp.multiplier;
          if (!(price > 0 && size > 0)) continue;
          // posSide long/short (hedge mode) else net: a forced SELL closes a long.
          const ps = x.posSide === "long" || x.posSide === "short" ? (x.posSide as "long" | "short") : x.side === "sell" ? "long" : "short";
          this.emit({ kind: "liquidation", ...this.meta(this.perp, num(x.ts), "okx.ws.liquidation-orders"), price, size, positionSide: ps });
        }
      }
      return;
    }
    const d = m.data[0];
    const ts = num(d.ts);
    if (ch === "open-interest") {
      const oiBase = num(d.oiCcy);
      if (!Number.isFinite(oiBase)) return;
      const oiUsdRaw = num(d.oiUsd);
      const oiUsd = Number.isFinite(oiUsdRaw) ? oiUsdRaw : this.mark !== null ? oiBase * this.mark : NaN;
      if (Number.isFinite(oiUsd)) this.emit({ kind: "open_interest", ...this.meta(this.perp, ts, "okx.ws.open-interest"), oiBase, oiUsd });
    } else if (ch === "funding-rate") {
      const rate = num(d.fundingRate);
      const ft = num(d.fundingTime), nft = num(d.nextFundingTime);
      const interval = ft > 0 && nft > ft ? (nft - ft) / 3_600_000 : 8;
      if (Number.isFinite(rate)) this.emit({ kind: "funding", ...this.meta(this.perp, ts, "okx.ws.funding-rate"), rate, intervalHours: interval, nextFundingTs: ft || null });
    } else if (ch === "mark-price") {
      this.mark = num(d.markPx);
      this.emit({ kind: "mark_index", ...this.meta(this.perp, ts, "okx.ws.mark-price"), mark: this.mark, index: this.index, last: this.last });
    } else if (ch === "index-tickers") {
      this.index = num(d.idxPx);
      this.emit({ kind: "mark_index", ...this.meta(this.perp, ts, "okx.ws.index-tickers"), mark: this.mark, index: this.index, last: this.last });
    }
  }

  private onBook(instId: string, action: string, d: Record<string, unknown>) {
    const inst = this.inst(instId);
    const st = this.books.get(instId);
    if (!inst || !st || !d) return;
    const bids = (d.bids as Row[]) ?? [];
    const asks = (d.asks as Row[]) ?? [];
    const seqId = num(d.seqId);
    const prevSeqId = num(d.prevSeqId);
    const ts = num(d.ts);
    const mult = inst.multiplier;
    const toLvls = (rows: Row[]) => rows.map((r) => [num(r[0]), num(r[1]) * mult] as [number, number]);

    if (action === "snapshot") {
      st.sb.clear();
      for (const r of bids) st.sb.set("bid", r[0], r[1], num(r[1]) === 0);
      for (const r of asks) st.sb.set("ask", r[0], r[1], num(r[1]) === 0);
      if (!this.verify(st, d.checksum)) return this.gap(inst, st, "snapshot checksum mismatch");
      const wasLive = st.resyncAttempt > 0;
      st.seq = Number.isFinite(seqId) ? seqId : null;
      st.live = true;
      st.resyncAttempt = 0;
      this.snapshot(inst, toLvls(bids), toLvls(asks), st.seq, ts, "okx.ws.books.snapshot", wasLive ? ["resynced"] : []);
      this.status(inst, "live");
      return;
    }
    if (!st.live) return;
    // Sequence reset by the venue (seqId < prevSeqId) or a broken chain → resync.
    if (Number.isFinite(prevSeqId) && st.seq !== null && prevSeqId !== st.seq) return this.gap(inst, st, `prevSeqId=${prevSeqId} != last seqId=${st.seq}`);
    if (Number.isFinite(seqId) && Number.isFinite(prevSeqId) && seqId < prevSeqId) return this.gap(inst, st, "venue sequence reset");
    for (const r of bids) st.sb.set("bid", r[0], r[1], num(r[1]) === 0);
    for (const r of asks) st.sb.set("ask", r[0], r[1], num(r[1]) === 0);
    if (!this.verify(st, d.checksum)) return this.gap(inst, st, "checksum mismatch");
    const prev = st.seq;
    if (Number.isFinite(seqId)) st.seq = seqId;
    // seqId == prevSeqId is a no-change heartbeat; nothing to emit.
    if (bids.length || asks.length) this.delta(inst, toLvls(bids), toLvls(asks), st.seq, st.seq, prev, ts, "okx.ws.books.update");
  }

  private verify(st: BookState, checksum: unknown): boolean {
    if (checksum === undefined || checksum === null) return true;
    return okxChecksum(st.sb.sorted("bid", 25), st.sb.sorted("ask", 25)) === num(checksum);
  }

  private gap(inst: InstrumentRef, st: BookState, detail: string) {
    st.live = false;
    st.seq = null;
    st.sb.clear();
    this.status(inst, "gap_recovering", detail);
    if (st.resyncTimer) clearTimeout(st.resyncTimer);
    const arg = { channel: "books", instId: inst.symbol };
    const delay = backoffDelay(st.resyncAttempt++, this.backoffBaseMs, this.random);
    st.resyncTimer = setTimeout(() => {
      if (!this.running || !this.sock) return;
      this.sock.send({ op: "unsubscribe", args: [arg] });
      this.sock.send({ op: "subscribe", args: [arg] });
    }, delay);
  }
}

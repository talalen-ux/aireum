# ATLAS — Quant Market Intelligence

Real-time, multi-venue crypto market intelligence for anticipating long **and** short decisions. ATLAS shows who is driving price, whether a move is led by spot or by leverage, where forced liquidations may happen, what would invalidate each thesis, and whether a position can survive adverse price paths.

It separates **observed** facts, **modeled** estimates and **inferred** intent everywhere. When data is missing it shows *Unavailable* and never invents a value.

> Research tool, not advice. "Strength" scores measure how much evidence agrees; they are not probabilities. No predictive edge is claimed until it is validated out of sample (see `research/`).

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000
npm test             # 105 unit/integration tests (vitest); research: 10 pytest tests
npm run build        # production build
```

* **Live**: your browser connects directly to public exchange WebSockets/REST (Binance, Bybit, OKX, Coinbase, Kraken, Hyperliquid, Deribit, Bitfinex, KuCoin). Venues blocked in your region or by CORS show as *Unavailable*.
* **Simulation**: a labeled synthetic market (multi-venue books with sequence numbers and injected gaps, trades, liquidations, OI and funding). It includes planted exhaustion episodes so every view can be explored offline.
* **Replay**: press ⏺ **Rec** to record the normalized event stream, download it as NDJSON, then load it with **Replay…**. The same engine processes it deterministically.

Optional server environment variables:

| Var | Enables |
|---|---|
| `ANTHROPIC_API_KEY` | Free-form AI analyst (`/api/analyst`, Claude Opus 5.5, grounded only on the computed snapshot; server-side refusal fallback enabled) |
| `FRED_API_KEY` | Macro panel: US 10Y, real yields, broad USD, Nasdaq, HY spreads, breakevens |

Keyboard: `1`–`0` switch views; `t` opens VIX 2B · Gann, `h` opens Profit Harvesting, `c` opens High-Conviction.

## What's inside

| Area | Where | Highlights |
|---|---|---|
| Venue adapters | `src/lib/adapters/` | Exchange-native L2 reconstruction: snapshot + sequenced deltas (Binance `U/u/pu`, OKX `seqId` + CRC32, Kraken CRC32, Deribit `change_id`, Bybit `u`, Coinbase `sequence_num`, Bitfinex checksum). Gap → resync, stale detection, clock-drift flags, duplicate-trade suppression, backoff with jitter. |
| Order book core | `src/lib/core/orderbook.ts` | Sequence validation, depth at standard bp bands, imbalance, microprice, slope, market-order slippage walk, replenishment/cancellation churn, cross-venue consolidation. |
| Engine (Web Worker) | `src/lib/engine/` | Point-in-time history bootstrap (Binance klines with taker-buy volume, OI history, funding). Multi-timeframe regime engine (5m to 1w) with documented features and robust z-scores. Lead–lag, price-impact asymmetry, walls and spoof-like pulls (unverified), modeled liquidation map with uncertainty bands, Opportunity Radar with lifecycle and audit trail. |
| **Liquidity Exhaustion & Reversal Engine** | `src/lib/engine/exhaustion.ts` | Six measured conditions (C1–C6): aggression persists, impact per unit of flow weakens, OI contracts, the passive side replenishes, spot aggression eases, forced flow decays. Mirrored for upside. Each signal has a trigger, an invalidation and in-sample historical analogs. |
| VIX 2B · Gann fan | `src/lib/engine/technicals.ts`, `src/lib/engine/dvol.ts` | Sperandeo 2B reversals on price and on volatility. The volatility series is Deribit DVOL, crypto's VIX, with a fallback to the price-derived Williams VIX Fix. A VIX 2B top (fear spike that fails) emits a long hypothesis on the radar. Gann fans run from the extreme swing pivots, with an explicit 1×1 scale (ATR per bar, or pivot-to-pivot). All are point-in-time and labeled as inferred heuristics, with in-sample outcome stats only. **CBOE VIX 2B → crypto** (`eventstudy.ts`, `/api/vix`): equity VIX daily bars come from CBOE's public CSV, with FRED as fallback. A VIX 2B top appears on the radar as a cross-asset long hypothesis. An event study measures BTC/ETH forward returns after VIX 2Bs against all days, with a permutation p-value. |
| Trade Lab | `src/lib/risk/`, `src/components/trade-lab/` | Binance/Bybit/OKX isolated and cross liquidation formulas with maintenance tiers, inverse contracts, ladders, sizing from max risk, fees/funding/slippage, and stop-vs-liquidation checks. A path-dependent Monte Carlo covers liquidation before rebound and stop failure. |
| Profit Harvesting | `src/lib/risk/harvest.ts`, `src/components/views/HarvestView.tsx`, `.claude/skills/atlas-futures-profit-harvesting/` | Two profit-taking styles compared at identical dollars at risk: (A) one position with reduce-only scale-outs, (B) independent fixed-net-profit trades (default $100). Fee-aware exit prices, break-even win rate, give-back price, liquidation buffer (suppressed when venue tiers are unknown), a cumulative loss budget that persists across sessions, and a path simulation with a hold baseline. Paper only. |
| High-Conviction research | `src/lib/risk/conviction.ts`, `src/components/views/ConvictionView.tsx`, `.claude/skills/atlas-high-conviction-futures/` | Forensic report on five shared profit cards (visible values vs inferred size, exposure and margin, ROI reconciliation, what cannot be known). A capital and survival matrix reverse-calculates the size a dollar target needs and, per leverage, the margin, the room before a knock-out and the no-edge chance of reaching the target first. Also an opportunity brief with a no-trade case and a research scorecard. Paper only. |
| Options | `src/lib/options/`, `src/components/options/` | Deribit chain, Black-Scholes greeks and IV solver, dealer GEX by strike under explicit assumptions, zero-gamma, vanna/charm, max pain (not a magnet), term structure, 25Δ risk reversal. |
| AI analyst | `src/lib/analyst/`, `src/app/api/analyst/` | Deterministic answers built only from computed observations: observation → interpretation → counterargument → implications → invalidation → confidence. An optional LLM mode is grounded on the same snapshot. |
| Journal | `src/lib/journal/` | Forecast calibration (Brier score, reliability chart) and discipline badges. Rewards calibration and process, never PnL, leverage or frequency. |
| Research | `research/` | Python walk-forward validation with purge/embargo, realistic costs, baselines, calibration and deflated Sharpe. See `research/README.md` for honest current results. |

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the data flow, the integrity guarantees and the production path (Go/Rust ingestion → Kafka → ClickHouse).

## Known limitations (read before trusting numbers)

* Exchange adapters are tested against fixture messages written from venue docs. They have not yet run against live venues from CI.
* Maintenance-margin tier tables in `src/lib/risk/exchanges.ts` are transcribed and versioned, and must be checked against each venue before use.
* Liquidation clusters are a **model**. Real positioning is not public.
* Macro calendar, ETF flows, on-chain and labeled-wallet data need licensed feeds. Those panels show *Unavailable* until one is connected.
* On synthetic data the exhaustion detector finds planted episodes but shows **no edge after costs** (`research/reports/`). Validate on real point-in-time data before using it.

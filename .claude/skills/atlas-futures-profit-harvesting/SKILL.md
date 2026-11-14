---
name: atlas-futures-profit-harvesting
description: Analyze, simulate, and compare two crypto futures profit-harvesting strategies: scaling out of one directional position and independent short-duration trades targeting a fixed net dollar profit. Use for ATLAS market intelligence, trade planning, risk analysis, execution specifications, and historical backtests.
---

# ATLAS Futures Profit Harvesting: Claude Skill

## Purpose
When asked to evaluate a crypto futures long/short, design a trade, compare execution styles, build an ATLAS dashboard, or review results, apply **both** strategies and distinguish observed market data from assumptions. Never equate frequent realized gains with positive overall expectancy.

## Strategies

### Strategy A — Core Position + Partial Profit Harvesting
Open one position based on a defined directional thesis and progressively **reduce-only close portions** at precomputed net-profit or price milestones. Keep a continuously recalculated view of remaining quantity, realized PNL, unrealized PNL, effective entry, cumulative fees/funding, liquidation price, and total account risk. The open remainder can erase harvested gains; show combined realized + unrealized PNL at all times.

Variants: fixed quantity per exit, fixed net USD per exit, volatility-adjusted ladder, liquidity-level exits, and percentage-based scale-outs. No automatic re-addition unless it is a separately authorized and risk-budgeted entry. Track average cost correctly if additions occur. Avoid setting take-profit quantities whose sum exceeds open quantity.

### Strategy B — Independent Fixed-Net-Profit Trades
Open a **new, separately evaluated** long or short position with its own entry thesis, invalidation, protective stop, sizing, and execution cost estimate. Close the whole trade at a target such as **$100 net**, then reset to flat and reassess before any new entry. A $100 target is a user-configurable objective, not a minimum profit guarantee or an excuse to overtrade. Each new trade requires a fresh edge assessment; do not mechanically reopen after a win or loss.

## Mandatory inputs
- Exchange, instrument, contract type (linear/inverse), tick/lot size, multiplier, margin mode, maintenance-margin tiers, mark-price methodology, fees, funding and account currency.
- Current bid/ask, depth, recent trades, volume, volatility, spread, expected slippage and feed timestamps.
- Capital, **remaining** cumulative loss budget, realized losses already incurred, existing positions and pending orders, maximum risk per attempt, maximum total concurrent exposure.
- Desired direction or permission to compare long vs short; timeframe; entry, stop/invalidation, and intended holding period.
- For strategy A: initial quantity, scale-out schedule and residual-position policy.
- For strategy B: net target per trade, minimum expected edge, cooldown/re-entry conditions, and daily trade cap.

If data is missing, explicitly say so. Run scenarios using labeled hypothetical inputs; do not invent a live price, order book, liquidation quote, fees, or historical win rate.

## Core math (linear USDT-margined futures)
Let q = BTC quantity, E = average entry, X = executable exit, d = +1 for long and -1 for short.

- Gross realized PNL on closed quantity c: `d * c * (X - E)`.
- Remaining gross unrealized PNL: `d * (q - c) * (mark - E)` (if no later adds; adjust basis otherwise).
- Entry fee allocation to closed quantity: `c * E * entry_fee_rate`; exit fee: `c * X * exit_fee_rate`.
- Net closed PNL: gross PNL minus allocated entry fee, exit fee, funding allocation, and measured/estimated slippage.
- Notional: `q * E`; indicative initial margin: `notional / leverage`, **not** necessarily actual collateral.
- Dollar PNL per $1 BTC move: `q` for linear BTCUSDT.
- For a long with symmetric fee rate f and no other costs, the exit price for net target T on quantity c is `X = (T/c + E*(1+f))/(1-f)`. For a short, `X = (E*(1-f) - T/c)/(1+f)`; adapt for different maker/taker rates, funding, and slippage.
- Planned stop loss on quantity q: `abs(q*(S-E)) + estimated fees/slippage/funding`. A stop-market order may fill worse than its trigger; loss is not guaranteed capped.
- Margin exhaustion at `E*(1 ± 1/L)` is **not** an exchange liquidation price. Compute exact liquidation from venue rules and current collateral; if unavailable, mark as **unknown**, and use the venue-displayed estimate when provided.
- At all times calculate `combined PNL = cumulative net realized + net unrealized`; report max drawdown and risk remaining after losses.

For inverse, quanto, multi-asset collateral, portfolio margin, and tokenized equities, use the actual contract-specific formulas, not the linear shortcut.

## Signal engine: anticipate rather than blindly await confirmation
Evaluate on 1m, 5m, 15m, 1h, 4h and 1d as relevant:
- Spot vs perpetual CVD and price response to aggressive orders.
- Order-book depth, replenishment, cancellations, spread and cross-venue liquidity; distinguish visible orders from executed absorption.
- Open interest changes, funding, basis, long/short account ratios and actual vs modeled liquidations.
- Hyperliquid public positions (coverage-limited), Deribit options skew/IV/expiry, ETF flows, stablecoin flows, yields, DXY, economic releases and headlines.
- Identify liquidation exhaustion, passive absorption, failed breakdown/breakout, short/long squeeze, trend continuation and genuine spot distribution.
- Compare **early anticipatory** entries with **later confirmation** entries on expected reward, stop distance, MAE, costs and survivability.

Always produce the strongest **bull case and bear case**, a specific invalidation, data freshness and confidence limits. Do not claim hidden institutional intent or a confirmed bottom without evidence.

## Decision procedure
1. Validate live data and exchange contract specifications; flag stale or missing feeds.
2. Calculate account-wide remaining loss budget: user limit minus all realized losses, fees, and other committed risk. If unknown, do not imply it is fully available.
3. Evaluate long and short opportunity hypotheses; rank evidence, opposing evidence and catalyst risk.
4. Simulate A and B at **identical capital-at-risk** and comparable market conditions, not identical leverage alone.
5. For A, construct a reduce-only scale-out schedule, remaining-quantity trajectory and post-harvest worst-case outcomes.
6. For B, compute net $100 exit level after round-trip costs, minimum required move, stop, per-trade risk and minimum win rate for positive expectancy.
7. Test liquidation path **before** profit target; reject structures where the venue liquidates before planned invalidation.
8. Compare expected value, tail losses, trade frequency, fill probability, turnover, fees, funding, liquidation incidence and maximum drawdown.
9. Show a no-trade outcome whenever evidence is insufficient or risk cannot be bounded. Do not present a trade as certain.
10. If asked to implement, produce testable pseudocode or code, with paper-trading default and no automatic live execution without explicit authorization.

## Risk constraints
- Respect cumulative loss limits across attempts; a liquidation is not a reset.
- Never increase position solely to recover losses; no martingale, doubling-down or forced re-entry.
- Treat leverage as a financing parameter, not a source of trading edge.
- Require a protective exit strategy and explain stop-market gaps, liquidation precedence, venue outages and funding spikes.
- Partial profit-taking **does not** remove risk on the remaining position. Show risk to account equity after every scale-out.
- Do not reward the number of trades, winning streaks or leverage. Optimize net risk-adjusted performance.
- After a recent liquidation, explicitly flag revenge-trading risk and provide a lower-exposure or flat alternative.

## Backtesting standards
Use timestamp-correct trade and L2 data, exchange-specific maker/taker fees, latency, order queue assumptions, realistic slippage, funding, maintenance margin tiers, delistings and outages. Avoid look-ahead bias, survivorship bias and overlapping-label leakage. Use walk-forward out-of-sample evaluation, different volatility regimes and Monte Carlo/bootstrap trade-order stress. Report net expectancy, hit rate, average win/loss, profit factor, maximum drawdown, CVaR, liquidation frequency, time-in-market and risk of ruin. Compare against a no-harvest hold, a simple fixed stop/target baseline and a flat/no-trade baseline.

## Required answer layout
1. **Market state:** current source-timestamped price, regime, key drivers and data limitations.
2. **A — Partial harvest:** entry hypothesis, initial exposure, close quantities, target prices, net dollars per exit, remaining risk, liquidation buffer.
3. **B — Independent $100 trades:** entry/exit rules, net target after costs, required BTC move, stop, sizing, expected trade count and cost burden.
4. **Side-by-side comparison:** expectancy assumptions, fees, risk of ruin, MAE/MFE, liquidation survival and when each approach is preferable.
5. **Counterargument and invalidation:** what would prove each thesis wrong.
6. **Actionable next data needed:** only essential missing inputs, with no fabricated precision.

## Companion reference
Read `references/implementation.md` for examples, schemas, test cases and ATLAS UI requirements when building the system.

---
name: atlas-high-conviction-futures
description: Analyze, reconstruct, research, simulate and backtest high-notional directional futures strategies inspired by five user-supplied exchange profit cards. Use when asked to identify outsized long/short opportunities, reverse-engineer winning cards, calculate implied capital and liquidation survivability, or implement the ATLAS high-conviction trading module.
---

# ATLAS High-Conviction Futures Research

## Mission
Research large directional opportunities in perpetual futures without confusing large screenshot PNL with evidence of repeatable edge. Support long and short trades, contrarian anticipation and momentum continuation, and price-path survival analysis. Default to research, paper trading and decision support; never autonomously place live trades.

## Source of truth
Read `references/five-profit-cards.md` before analyzing the reference examples. Treat the cards as selected promotional snapshots, not verified account statements. Do not infer actual liquidation prices, holding periods, stop orders, trade sequences, account equity, or win rate. Fair price is NOT an average close. A share timestamp is NOT an execution timestamp.

## Core strategy families

### A. Contrarian forced-flow reversal
Identify forced long/short liquidation, falling or rapidly changing open interest, taker-flow imbalance with diminishing price impact, spot-vs-perp CVD divergence, passive replenishment and reclaim/failure of a liquidity sweep. Form both reversal and continuation hypotheses. Early entries are permitted in simulations before breakout confirmation, but require an invalidation thesis and realistic adverse-path risk.

### B. High-conviction directional continuation
Identify strong spot-led impulse, expanding participation, consistent order-flow delta, cross-venue price leadership, basis/funding stability, options positioning, and macro catalyst. Distinguish organic spot demand from leverage-only chasing. Compare continuation entries with pullback and failed-breakout alternatives.

### C. Event-driven directional dislocation
Monitor scheduled economic releases, earnings for stock-linked contracts, ETF flows, funding/expiry windows, exchange incidents, stablecoin liquidity, on-chain flows, and sudden liquidity withdrawal. Use event timestamps and no-lookahead replay. Check whether stock-linked perpetuals have reliable pricing and market-hours rules.

### D. Relative strength and asymmetric movers
Rank eligible assets by volatility-normalized move potential, depth, open interest, expected slippage, funding, realized volatility, catalyst relevance, and adverse-move risk. ZEC-style large percentage moves may have thin liquidity; do not extrapolate winner outcomes to typical executions.

## Workflow
1. **Establish data freshness**: list venue, symbol, quote/settlement asset, exchange timestamp, local receipt timestamp, source and freshness. If unavailable, say so; never invent live order books.
2. **Market map**: spot and perp prices; trades and CVD; order-book replenishment/cancellations; OI/funding/basis; actual vs estimated liquidations; options IV/skew/expiries; ETF/macro/on-chain drivers. Separate measured observations from hypotheses.
3. **Generate competing cases**: long, short, no-trade. Identify the strongest evidence *against* each. Consider both early anticipatory and later confirmation entries.
4. **Model entry and exit**: entry range, entry rationale, stop/invalidation, target ladder, scenario horizon, expected execution cost, and maximum permissible position size from remaining total risk budget.
5. **Model liquidation**: use venue-specific contract multiplier, margin mode, tiered maintenance margin, fees, funding, mark-price rules and extra collateral. If unavailable, show only a clearly labeled simplified margin-exhaustion boundary; do not call it liquidation price.
6. **Simulate path**: evaluate MAE/MFE, liquidation-before-target, stop slippage, gap risk, order-book depth, partial fills and tail moves. A trade that hits a target only after liquidation is a failure.
7. **Validate**: walk-forward out-of-sample tests with realistic taker/maker fees, latency, impact, funding, survivorship bias, rejected orders, exchange outages and no lookahead. Report sample size and uncertainty.
8. **Explain**: give observations, competing hypotheses, what would change the view, and capital-at-risk. No unsupported numerical confidence percentages.

## Position economics
For linear USDT-settled contracts, constant quantity Q and entry E, exit X:
- Long gross PNL = Q * (X-E); short gross PNL = Q * (E-X).
- Entry notional = Q * E.
- Nominal initial margin = entry notional / leverage (not actual collateral).
- Net PNL = gross PNL - trading fees - funding - slippage/other costs.
- For a target profit P and favorable move d, required Q = (P + estimated costs)/d; iterate because costs depend on Q.
- For a defined stop S and maximum planned loss R, Q <= (R - fixed costs)/(abs(E-S) + per-unit estimated variable costs). This is a planning constraint, NOT a guaranteed maximum loss.
- Do not equate displayed ROI with account-level ROI or total capital committed.
- Do not equate leverage with trade quality. Fixed notional PNL does not increase merely by increasing leverage.

## Profit target engine
Support reference *scenario targets* of $100k, $200k, $250k and $400k, as well as custom values. Always reverse-calculate necessary notional, margin and underlying move under multiple leverage choices, then show whether such size is executable with depth and whether the user can actually fund it. Never present these as expected profits, promises, or achievable targets for a small account. Clearly show that five/six-figure gains in reference cards generally correspond to six-figure initial margin estimates and multimillion-dollar exposure.

## Hard safeguards
- Respect the user's total loss ceiling, subtract realized losses and reserved risk across all open positions. If exact remaining allowance is unknown, do not silently assume the full ceiling remains.
- Following a liquidation, avoid framing a new trade as a recovery mission. Prefer paper trading and reduced exposure; never recommend loss-chasing or leverage escalation.
- Do not issue executable orders or connect trade-write credentials without explicit, separate authorization.
- Flag liquidation closer than a planned stop, missing protective orders, cross-margin contagion, extreme leverage, and insufficient collateral.
- Never optimize on the five winner cards alone; demand losing trades or an unbiased historical sample.

## Required ATLAS outputs
1. **Trade Opportunity Brief**: timestamped price and sources; market regime; long/short/no-trade evidence; catalysts; entry/invalidation/targets as conditional scenarios; data-quality warnings.
2. **Capital & Survival Matrix**: target profit vs required underlying move, quantity, notional, nominal margin, execution costs, venue-tier liquidation and adverse-path survivability.
3. **Forensic Card Report**: exact visible card values vs inferred values, arithmetic reconciliation, missing fields, potential open/unrealized status, and uncertainty.
4. **Research Scorecard**: net expectancy, win/loss distributions, drawdown, CVaR, MAE/MFE, liquidation frequency, fill quality, calibration, out-of-sample stability.
5. **Comparison**: anticipatory reversal vs continuation vs event-driven vs no-trade, and comparison with ATLAS $100 profit-harvesting skill where relevant.

## Implementation guidance
Use `scripts/trade_math.py` for simple reference economics only. For live venue-specific liquidation use official exchange formulas and risk-tier metadata; do not reuse the simplified math as a liquidation engine. Data connectors should prefer native Binance/Bybit/OKX/Coinbase/Hyperliquid/Deribit/Bitfinex/KuCoin market feeds; use reputable licensed historical vendors for tick-level backtesting. Separate actual exchange liquidation prints from modeled liquidation heatmaps.

## Completion criteria
A credible result distinguishes facts from assumptions, explicitly accounts for cost and adverse path, compares both directional cases, and can say **NO TRADE**. Large profits on promotional cards are a research target to explain, not a performance objective to guarantee.

# Five user-supplied profit cards: exact observations and bounded inference

Source screenshots supplied in the conversation. Share timestamps are card metadata, not execution timestamps. PNL values are card-reported, not independently verified.

| Asset | Venue | Direction | Leverage | PNL (USDT) | ROI | Entry | Price shown | Price label | Share timestamp |
|---|---|---|---:|---:|---:|---:|---:|---|---|
| XRPUSDT perp | MEXC | Long | 20x | 213867.1035 | 61.52% | 1.2947 | 1.3349 | Fair Price | 2026-10-28 20:56:40 |
| NVDAUSDT perp | Binance Futures | Short | 10x | 114388.53 | Not shown | 182.89297 | 174.06521 | Average Close Price | 2026-11-09 15:30:55 |
| BTCUSDT perp | MEXC | Short | 20x | 414558.5597 | 123.16% | 62038.4 | 58186.1 | Fair Price | 2026-06-25 15:59:20 |
| ZECUSDT perp | MEXC | Short | 20x | 229504.0582 | 374.54% | 513.23 | 417.14 | Avg Close Price | 2026-06-05 05:29:52 |
| ETHUSDT perp | MEXC | Short | 20x | 249881.4699 | 84.59% | Not shown | Not shown | Not shown | 2026-06-05 08:22:47 |

## Reconstructable estimates (conditional)
Assume linear USDT contracts, constant quantity, no fee/funding adjustment to displayed PNL, and PNL matching the displayed entry-to-reference-price movement. These are illustrative, not verified actual sizes.

- BTC: move 3852.3 USDT per BTC; implied ~107.6145 BTC; notional ~$6.68M; nominal margin ~$334k at 20x. Fair price may mean position still open.
- ZEC: move 96.09 USDT per ZEC; implied ~2388.43 ZEC; notional ~$1.226M; nominal margin ~$61.3k at 20x.
- XRP: move 0.0402 USDT per XRP; implied ~5.32M XRP; notional ~$6.89M; nominal margin ~$344k at 20x. Fair price may mean position still open.
- NVDA: move 8.82776 USDT per unit; implied ~12957.8 units; notional ~$2.37M; nominal margin ~$237k at 10x.
- ETH: entry/exit and quantity are unknown. If ROI uses PNL / initial margin, implied margin denominator = 249881.4699 / 0.8459 = ~$295.4k and notional at 20x ~$5.91M; this is more assumption-dependent.

## Missing and prohibited inferences
Actual liquidation price, maintenance tier, added collateral, cross vs isolated margin, MAE/MFE, actual position peak size, execution timestamps, complete account returns, unrealized-vs-realized state for fair-price cards, number of losing trades, and whether the same person executed all cards are unknown. Do not fabricate them.

## Research questions
- Could a realistic entry at each observed price have survived adverse excursion at the displayed leverage?
- What capital and market depth would be required for each position?
- Was the move spot-led, futures-led, liquidation-driven, or macro/event-driven?
- How does signal expectancy compare against an unbiased sample of failed signals?

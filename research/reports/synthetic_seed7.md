# ATLAS — Liquidity Exhaustion & Reversal: walk-forward validation report

> **SYNTHETIC DATA.** These results come from a generator with planted episodes. They verify that the harness and detector behave as designed; they say **nothing** about real-market edge.

> No predictive edge is claimed until results are independently validated out of sample on real, point-in-time data.

- Generated: 2026-11-12T22:59:32.185704+00:00
- Data: 20000 bars × 5m, 2024-01-01T00:00:00+00:00 → 2024-03-10T10:35:00+00:00
- Walk-forward: 5 expanding splits, purge + embargo = label horizon
- Detector events: 23 total, 19 in test folds

## Classification (test folds only)

Label: triple barrier ±2.0·ATR within 48 bars.

- Precision of events: **0.42** vs unconditional base rate long 0.49 / short 0.50
- Recall of major long reversals (≥3·ATR from local extreme): 2/128 = 0.02
- Recall of major short reversals (≥3·ATR from local extreme): 3/129 = 0.02
- Calibration (logistic fit on train events, scored on test): Brier 0.1903 vs climatology 0.2572 → skill 0.260 (n=8)

| bin | n | mean predicted | observed freq |
|---|---|---|---|
| 0.2-0.3 | 1 | 0.26 | 1.00 |
| 0.3-0.4 | 2 | 0.39 | 0.00 |
| 0.4-0.5 | 3 | 0.47 | 0.33 |
| 0.9-1.0 | 2 | 1.00 | 1.00 |

## Planted episodes (synthetic)

- Exhaustion detected: 8/15
- False alarms on continuation decoys: 0/25

## Trading results — exit `H24` (net of costs unless noted)

| strategy | trades | expectancy bps [95% CI] | gross bps | hit | total bps | max DD bps | trades/day |
|---|---|---|---|---|---|---|---|
| exhaustion | 19 | -22.52 [-33.60, -12.34] | -8.07 | 0.21 | -428 | 433 | 0.33 |
| exhaustion_zero_cost | 19 | -8.07 [-19.31, 2.16] | -8.07 | 0.42 | -153 | 205 | 0.33 |
| mean_reversion | 165 | -39.15 [-46.09, -32.00] | -24.34 | 0.20 | -6459 | 6459 | 2.89 |
| momentum | 165 | 9.50 [2.26, 16.40] | 24.34 | 0.48 | 1567 | 239 | 2.89 |
| always_flat | 0 | 0.00 [—, —] | 0.00 | — | 0 | 0 | 0.00 |

Random entries (matched count, 50 draws): mean expectancy -14.43 bps, 95th pct -0.55; exhaustion beats 14% of draws.

Per volatility regime (terciles fixed from first train block):

| regime | trades | expectancy bps | hit |
|---|---|---|---|
| low_vol | 10 | -21.67 | 0.30 |
| mid_vol | 4 | -22.81 | 0.25 |
| high_vol | 5 | -24.00 | 0.00 |

Deflated Sharpe probability (trials = exit variants × strategies compared): **0.000**. Every additional parameter set tried must be added to the trial count.

## Trading results — exit `ATR1.5/3.0_H48` (net of costs unless noted)

| strategy | trades | expectancy bps [95% CI] | gross bps | hit | total bps | max DD bps | trades/day |
|---|---|---|---|---|---|---|---|
| exhaustion | 19 | -16.52 [-23.87, -8.07] | -1.92 | 0.26 | -314 | 325 | 0.33 |
| exhaustion_zero_cost | 19 | -1.92 [-9.36, 6.59] | -1.92 | 0.26 | -36 | 103 | 0.33 |
| mean_reversion | 171 | -19.76 [-22.16, -17.22] | -4.93 | 0.21 | -3379 | 3401 | 3.00 |
| momentum | 169 | -7.11 [-10.10, -4.16] | 7.73 | 0.50 | -1202 | 1230 | 2.96 |
| always_flat | 0 | 0.00 [—, —] | 0.00 | — | 0 | 0 | 0.00 |

Random entries (matched count, 50 draws): mean expectancy -14.46 bps, 95th pct -4.99; exhaustion beats 26% of draws.

Per volatility regime (terciles fixed from first train block):

| regime | trades | expectancy bps | hit |
|---|---|---|---|
| low_vol | 10 | -14.93 | 0.30 |
| mid_vol | 4 | -26.30 | 0.00 |
| high_vol | 5 | -11.87 | 0.40 |

Deflated Sharpe probability (trials = exit variants × strategies compared): **0.000**. Every additional parameter set tried must be added to the trial count.

## Caveats

- Costs: spread, taker fees both sides, square-root slippage, adverse-selection haircut, funding accrual, gap-through stop fills. Queue position, partial fills and latency are not modeled.
- Detector thresholds are fixed defaults, not tuned on this data; tuning must happen inside train folds only.
- Survivorship: BTC/ETH perps only; delisted contracts and venue outages are not represented.

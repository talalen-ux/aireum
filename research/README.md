# ATLAS research & validation harness

This harness checks the **Liquidity Exhaustion & Reversal Engine** (and the baselines it has to beat) on point-in-time data, using walk-forward splits and realistic costs.

> **No predictive edge is claimed.** The detector is a research hypothesis. Nothing here, and nothing in the ATLAS UI, may be described as an "edge" until it has been independently validated out of sample on real, point-in-time data, with the trial count disclosed. The bundled synthetic run only checks that the harness and detector behave as designed.

## Layout

| file | purpose |
|---|---|
| `atlas_research/data.py` | Loaders for Binance public-data dumps (aggTrades, UM metrics/OI, fundingRate). Builds point-in-time bars with as-of joins. Also a synthetic generator with planted exhaustion episodes and continuation decoys, used by tests only. |
| `atlas_research/features.py` | Feature definitions that mirror the TS engine. Every rolling statistic uses past data only. |
| `atlas_research/exhaustion.py` | The detector: symmetric long/short, with invalidation levels. |
| `atlas_research/backtest.py` | Next-bar-open execution, costs, walk-forward splits with purge and embargo, labels, metrics, baselines, and deflated Sharpe. |
| `atlas_research/report.py` | Validation pipeline that writes Markdown and JSON reports. |
| `run_validation.py` | CLI. |
| `tests/` | pytest: no-look-ahead, split integrity, cost monotonicity, next-bar execution, detector vs background rate, decoys, and loaders. |

```bash
python3 -m venv research/.venv && research/.venv/bin/pip install -r research/requirements.txt
research/.venv/bin/python -m pytest -q research/tests
research/.venv/bin/python research/run_validation.py --synthetic        # -> research/reports/synthetic_seed7.{md,json}
research/.venv/bin/python research/run_validation.py --data-dir data/BTCUSDT --symbol BTCUSDT
```

## Feature definitions (keep in sync with the TS engine)

All features are computed on bar `t` from bars `≤ t`. Z-score history is `[t-W, t-1]` (default W = 288 five-minute bars = 1 day, with at least 60 bars).

- `signed = aggressive buy − aggressive sell` in base units. In Binance dumps, `is_buyer_maker = true` means the aggressor **sold**.
- `cvd_slope` is the OLS slope of cumulative signed volume over `w_flow = 12` bars.
- `kyle_lambda = Σ(ret_bps·signed) / Σ(signed²)` over `w_lambda = 24` bars. This is a through-origin OLS. It measures bps of price move per unit of aggression and stays robust when flow is persistently one-sided.
- `impact_decay = ln(λ_last 12 bars / λ_preceding 24 bars)`. The two windows do not overlap. It is NaN when the earlier λ ≤ 0.
- `oi_chg = ln(OI_t / OI_{t−12})`.
- `spot_perp_div = z(spot cvd_slope) − z(perp cvd_slope)`.
- `absorption = |z(signed)| / max(|z(ret)|, 0.25)`.
- `robust_z = (x − median) / (1.4826·MAD)`, falling back to std when MAD is zero, clipped to ±6, and NaN when history is too short.

## Detector (downside exhaustion → LONG hypothesis; the upside case is the exact mirror)

1. Selling persists: `z(perp cvd_slope) ≤ −1`.
2. Impact is weakening: `impact_decay ≤ ln 0.5`. Each unit sold now moves price less than half as much as in the preceding window.
3. OI is contracting: `z(oi_chg) ≤ −0.5`.
4. Spot selling is subsiding: `spot_perp_div ≥ +0.5`.
5. Context: a decline has already happened, `z(Σ12 returns) ≤ −1`.

The event fires on the rising edge, with a 24-bar cooldown. Conditions whose inputs are missing (no spot or no OI) are reported as unavailable and are never imputed. The invalidation level is the 36-bar low − 1·ATR (for shorts, the 36-bar high + 1·ATR).

## Validation methodology

- **Point in time.** Signals on bar `t` fill at the open of `t+1`. OI and funding snapshots are joined backward on bar close time. Labels may look forward, but they are used only for scoring.
- **Walk-forward.** There are 5 expanding (or rolling) splits. Train ends `purge = label horizon` bars before each test block, and the first `embargo` bars of each test block are dropped. Probability calibration (a small L2 logistic model on event features) is fit on train-fold events only.
- **Costs.** Each side pays half spread + taker fee + square-root slippage `base + k·100·√(notional / bar $ volume)`. There is also an adverse-selection haircut and funding accrual: longs pay positive funding, using 8h-normalized rates. Stops that gap through fill at the bar open. If stop and target are both touched in one bar, the stop is assumed to hit first.
- **Exit variants.** A fixed horizon H=24, and ATR stop 1.5 / target 3.0 with H=48.
- **Baselines.**
  - Random entries matched to the detector's signal count (50 draws, percentile reported).
  - Return-z mean reversion.
  - Momentum.
  - Always flat.
- **Metrics.**
  - Precision vs the unconditional triple-barrier base rate.
  - Recall of major reversals (≥ 3·ATR from a local extreme).
  - Brier score vs climatology, plus reliability bins.
  - Expectancy after costs, with a bootstrap 95% CI.
  - Hit rate, max drawdown, and turnover.
  - Per-volatility-tercile stability, with thresholds frozen from the first train block.
  - Deflated Sharpe probability, where the trial count is variants × strategies. **Add every parameter set you try to the trial count.**
- **Biases guarded.**
  - Look-ahead: tested by perturbing future data and checking that past features and events are identical.
  - Survivorship: limited to BTC/ETH perps, and stated in the report.
  - Overfitting: thresholds are fixed defaults. Any tuning must happen inside train folds.

## Getting real data (Binance public data, no API key)

Base: `https://data.binance.vision/`. Unzip each file into the directory layout shown below.

```
# perp aggressive trades (daily)
https://data.binance.vision/data/futures/um/daily/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2024-06-01.zip
# spot aggressive trades (daily)
https://data.binance.vision/data/spot/daily/aggTrades/BTCUSDT/BTCUSDT-aggTrades-2024-06-01.zip
# perp metrics: 5m open interest snapshots (daily)
https://data.binance.vision/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-2024-06-01.zip
# funding rate (monthly)
https://data.binance.vision/data/futures/um/monthly/fundingRate/BTCUSDT/BTCUSDT-fundingRate-2024-06.zip
# (optional) klines
https://data.binance.vision/data/futures/um/daily/klines/BTCUSDT/5m/BTCUSDT-5m-2024-06-01.zip
```

Each zip has a matching `.CHECKSUM` file (SHA256). Verify it. Expected layout:

```
data/BTCUSDT/perp/aggTrades/*.csv
data/BTCUSDT/spot/aggTrades/*.csv
data/BTCUSDT/perp/metrics/*.csv
data/BTCUSDT/perp/fundingRate/*.csv
```

Example fetch loop:

```bash
for d in $(seq -f "2024-06-%02g" 1 30); do
  for kind in "futures/um/daily/aggTrades:perp/aggTrades" "spot/daily/aggTrades:spot/aggTrades" "futures/um/daily/metrics:perp/metrics"; do
    src=${kind%%:*}; dst=data/BTCUSDT/${kind##*:}; mkdir -p $dst
    name=$( [ "${src##*/}" = metrics ] && echo "BTCUSDT-metrics-$d" || echo "BTCUSDT-aggTrades-$d" )
    curl -sfO "https://data.binance.vision/data/$src/BTCUSDT/$name.zip" && unzip -oq $name.zip -d $dst && rm $name.zip
  done
done
```

Notes:

- Spot aggTrades timestamps switched from ms to µs in 2025. The loader detects the unit.
- Futures CSVs have a header row and spot CSVs do not. The loader handles both.
- Duplicate aggregate trade ids are dropped.

For a credible evaluation, use at least 6–12 months covering several regimes. Report every configuration tried.

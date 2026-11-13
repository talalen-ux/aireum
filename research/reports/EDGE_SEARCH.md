# Edge search on real daily data (2015 → May 2026)

Reproduce: download the three CSVs listed in `edge_search.py` into `research/data_ext/`, then
`python edge_search.py && python edge_robustness.py`.

Data: Coin Metrics community data (BTC, ETH daily price and on-chain), CBOE VIX daily OHLC.
Design: rules fixed up front; discovery 2015–2020, holdout 2021–2026 (never tuned on); ETH run with identical rules;
10 bp cost per position change; timing p-value from 5,000 circular shifts of the position series.

## Findings

| Hypothesis | Discovery (2015–20) | Holdout (2021–26) | Verdict |
|---|---|---|---|
| VIX 2B top → BTC up | +139 bp next day vs +28 bp base, p = 0.03 | +36 bp vs +9 bp next day (p = 0.26); 5-day +5 bp vs +44 bp base, hit 43% | **Did not survive** |
| VIX 2B bottom → BTC down | no (BTC rose more than usual) | no | **Not supported** |
| VIX below 20d average → long | worse than buy & hold | worse than buy & hold | **No** |
| Exchange net outflow → long | weak | BTC Sharpe 0.82 vs 0.60 (p = 0.06); ETH failed | **Inconsistent**; data is also revised after the fact |
| Momentum, 30d return > 0 → long | Sharpe 1.66 vs 1.39 (p = 0.02) | BTC 0.80 vs 0.60 (p = 0.07); ETH 1.02 vs 0.64 (p = 0.04) | **Held up** |
| Price > 100d average → long | Sharpe 1.60 vs 1.39 (p = 0.04) | BTC 0.88 vs 0.60 (p = 0.07); ETH 0.70 vs 0.64 (p = 0.17) | **Held up on BTC, weak on ETH** |

Momentum robustness (holdout Sharpe, buy & hold = 0.60 BTC / 0.64 ETH): lookbacks of 30–120 days give 0.73–0.86 on BTC
and 0.76–1.02 on ETH. Lookbacks of 10–20 days failed on BTC. Maximum drawdown on BTC fell from −77% to about −48% to −60%.

## Caveats
* Seven rules × two assets were tested; holdout p-values of 0.04–0.15 are suggestive, not proof.
* The momentum benefit is concentrated in avoiding 2022. It badly lagged in 2024 (BTC +37% vs +114%).
* Daily closes only; no intraday, funding or order-book data were available for this test.

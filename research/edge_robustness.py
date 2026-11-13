"""Robustness of time-series momentum across lookbacks (real data). Run after edge_search.py."""
import json
from pathlib import Path
import pandas as pd
from edge_search import load_asset, evaluate, START, OUT

rows = {}
for name in ("btc", "eth"):
    px = load_asset(name).loc[START:]["PriceUSD"]
    rows[name] = []
    for lb in (10, 20, 30, 45, 60, 90, 120):
        r = evaluate(f"TSMOM {lb}d", (px.pct_change(lb) > 0).astype(float), px)
        rows[name].append(r)
        o, i = r["OOS"], r["IS"]
        print(f"{name} TSMOM {lb:3d}d | IS Sharpe {i['sharpe']:.2f} (B&H {i['bh_sharpe']:.2f}) p={i['p_timing']:.3f} | OOS CAGR {o['cagr']*100:5.1f}% Sharpe {o['sharpe']:.2f} (B&H {o['bh_sharpe']:.2f}) DD {o['max_dd']*100:.0f}% (B&H {o['bh_max_dd']*100:.0f}%) p={o['p_timing']:.3f}")
    # year-by-year OOS for 30d
    pos = (px.pct_change(30) > 0).astype(float)
    r1 = px.pct_change().shift(-1)
    sr = (pos * r1 - pos.diff().abs().fillna(0) * 10e-4).loc["2021":]
    yr = pd.DataFrame({"strat": (1 + sr).groupby(sr.index.year).prod() - 1, "bh": (1 + r1.loc["2021":]).groupby(r1.loc["2021":].index.year).prod() - 1})
    print(yr.round(3).to_string()); rows[name + "_yearly_30d"] = yr.round(4).to_dict()
(OUT / "edge_robustness.json").write_text(json.dumps(rows, indent=2, default=str))

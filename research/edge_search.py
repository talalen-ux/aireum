"""Edge search on REAL daily data (Coin Metrics community data + CBOE VIX).

Design (fixed before looking at holdout results):
  * Discovery sample : 2015-01-01 .. 2020-12-31   (in-sample, IS)
  * Holdout sample   : 2021-01-01 .. end of data  (out-of-sample, OOS) -- never used for tuning
  * Second asset     : ETH with the identical rules (no refit)
  * Costs            : 10 bps per unit of position change (fee + slippage), daily close-to-close
  * Timing           : signal uses data through day D close; position earns D -> D+1.
                       On-chain metrics get one extra day of lag (publication delay).
  * Significance     : circular-shift test. The position series is rotated by a random offset
                       (keeps its autocorrelation and time-in-market) 5000 times; p = share of
                       rotations whose Sharpe >= the real one. Tests TIMING skill, not beta.
  * Rules are pre-specified with textbook parameters. No grid search.

Data caveat: Coin Metrics on-chain exchange-flow series are revised as address labels improve,
so flow-based rules carry revision (look-ahead) risk that this test cannot remove.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

DATA = Path(__file__).parent / "data_ext"
OUT = Path(__file__).parent / "reports"
COST = 10e-4
SPLIT = "2021-01-01"
START = "2015-01-01"
RNG = np.random.default_rng(7)


# ----------------------------------------------------------------- data
def load_asset(name: str) -> pd.DataFrame:
    df = pd.read_csv(DATA / f"{name}.csv", parse_dates=["time"], low_memory=False).set_index("time")
    cols = [c for c in ["PriceUSD", "CapMVRVCur", "FlowInExNtv", "FlowOutExNtv", "SplyExNtv", "SplyCur"] if c in df.columns]
    df = df[cols].apply(pd.to_numeric, errors="coerce")
    return df[df["PriceUSD"].notna()]


def load_vix() -> pd.DataFrame:
    v = pd.read_csv(DATA / "vix.csv", parse_dates=["DATE"]).set_index("DATE")
    v.columns = [c.lower() for c in v.columns]
    return v.dropna()


# ----------------------------------------------------------------- 2B (port of src/lib/engine/technicals.ts)
def detect_2b(h: np.ndarray, l: np.ndarray, c: np.ndarray, k=3, window=3, min_pen_atr=0.1, lookback=60):
    """Returns list of (kind, confirm_idx). Uses only pivots confirmed before the breakout bar."""
    n = len(c)
    piv = []  # (i, kind, price, confirmed_at)
    for i in range(k, n - k):
        left_h, right_h = h[i - k:i], h[i + 1:i + k + 1]
        left_l, right_l = l[i - k:i], l[i + 1:i + k + 1]
        if (left_h < h[i]).all() and (right_h <= h[i]).all():
            piv.append((i, "high", h[i], i + k))
        if (left_l > l[i]).all() and (right_l >= l[i]).all():
            piv.append((i, "low", l[i], i + k))
    tr = np.maximum(h - l, np.maximum(np.abs(h - np.roll(c, 1)), np.abs(l - np.roll(c, 1))))
    tr[0] = h[0] - l[0]
    atr = pd.Series(tr).rolling(14, min_periods=1).mean().to_numpy()
    out, used = [], set()
    pi = 0
    known_high = known_low = None
    piv_sorted = sorted(piv, key=lambda p: p[3])
    for b in range(k + 1, n):
        while pi < len(piv_sorted) and piv_sorted[pi][3] < b:
            p = piv_sorted[pi]
            if p[1] == "high":
                if known_high is None or p[0] > known_high[0]:
                    known_high = p
            else:
                if known_low is None or p[0] > known_low[0]:
                    known_low = p
            pi += 1
        for p in (known_high, known_low):
            if p is None or b - p[0] > lookback or (p[1], p[0]) in used:
                continue
            top = p[1] == "high"
            pen = (h[b] - p[2]) if top else (p[2] - l[b])
            if pen < min_pen_atr * atr[b]:
                continue
            used.add((p[1], p[0]))
            for j in range(b, min(n, b + window)):
                if (c[j] < p[2]) if top else (c[j] > p[2]):
                    out.append(("top" if top else "bottom", j))
                    break
    return out


# ----------------------------------------------------------------- evaluation
def perf(ret: pd.Series) -> dict:
    ret = ret.dropna()
    if len(ret) < 30:
        return {}
    eq = (1 + ret).cumprod()
    yrs = len(ret) / 365.25
    dd = (eq / eq.cummax() - 1).min()
    sd = ret.std()
    return {
        "cagr": float(eq.iloc[-1] ** (1 / yrs) - 1),
        "sharpe": float(ret.mean() / sd * np.sqrt(365.25)) if sd > 0 else 0.0,
        "max_dd": float(dd),
        "days": int(len(ret)),
    }


def strat_returns(pos: pd.Series, r1: pd.Series) -> pd.Series:
    """pos[D] decided at close D earns r1[D] = close D -> D+1. Costs on position changes."""
    pos = pos.reindex(r1.index).fillna(0.0)
    turn = pos.diff().abs().fillna(pos.abs())
    return pos * r1 - turn * COST


def shift_pvalue(pos: pd.Series, r1: pd.Series, draws=5000) -> float:
    p = pos.reindex(r1.index).fillna(0.0).to_numpy()
    r = r1.to_numpy()
    ok = ~np.isnan(r)
    p, r = p[ok], r[ok]
    if p.std() == 0:
        return 1.0

    def sharpe(pp):
        turn = np.abs(np.diff(pp, prepend=pp[0]))
        x = pp * r - turn * COST
        s = x.std()
        return x.mean() / s if s > 0 else -9

    real = sharpe(p)
    n = len(p)
    offs = RNG.integers(20, n - 20, size=draws)
    ge = sum(sharpe(np.roll(p, int(o))) >= real for o in offs)
    return float((ge + 1) / (draws + 1))


def evaluate(name: str, pos: pd.Series, px: pd.Series) -> dict:
    r1 = px.pct_change().shift(-1)  # close D -> D+1
    res = {"rule": name}
    for label, sl in (("IS", slice(START, "2020-12-31")), ("OOS", slice(SPLIT, None))):
        rr, pp = r1.loc[sl].dropna(), pos.loc[sl]
        sr = strat_returns(pp, rr)
        bh = perf(rr)
        st = perf(sr)
        expo = float(pp.reindex(rr.index).fillna(0).mean())
        res[label] = {
            **st,
            "exposure": expo,
            "trades_per_yr": float(pp.reindex(rr.index).fillna(0).diff().abs().sum() / 2 / max(1e-9, len(rr) / 365.25)),
            "bh_cagr": bh.get("cagr"), "bh_sharpe": bh.get("sharpe"), "bh_max_dd": bh.get("max_dd"),
            "p_timing": shift_pvalue(pp, rr),
        }
    return res


# ----------------------------------------------------------------- rules (pre-specified)
def build_rules(a: pd.DataFrame, vix: pd.DataFrame) -> dict[str, pd.Series]:
    px = a["PriceUSD"]
    idx = px.index
    rules: dict[str, pd.Series] = {}

    # R1  VIX 2B top -> long 5 days (the user's hypothesis). VIX close (~21:15 UTC) precedes the BTC daily close.
    sig = detect_2b(vix["high"].to_numpy(), vix["low"].to_numpy(), vix["close"].to_numpy())
    top_days = pd.DatetimeIndex([vix.index[j] for kind, j in sig if kind == "top"])
    bot_days = pd.DatetimeIndex([vix.index[j] for kind, j in sig if kind == "bottom"])
    ev = pd.Series(0.0, index=idx)
    ev.loc[ev.index.intersection(top_days)] = 1.0
    rules["R1 VIX 2B top -> long 5d"] = (ev.rolling(5, min_periods=1).max() > 0).astype(float)

    # R2  VIX falling regime: long when VIX close < its 20d SMA (weekend = last value)
    vreg = (vix["close"] < vix["close"].rolling(20).mean()).astype(float).reindex(idx, method="ffill")
    rules["R2 VIX < 20d SMA -> long"] = vreg

    # R3  Time-series momentum: long when 30d return > 0
    rules["R3 TSMOM 30d > 0 -> long"] = (px.pct_change(30) > 0).astype(float)

    # R4  Trend filter: long when price > 100d SMA
    trend = (px > px.rolling(100).mean()).astype(float)
    rules["R4 price > 100d SMA -> long"] = trend

    # R5  Exchange net outflow: 7d (out - in)/supply, z vs trailing 365d > 0 -> long. One extra day lag.
    if {"FlowInExNtv", "FlowOutExNtv", "SplyCur"} <= set(a.columns) and a["FlowInExNtv"].notna().sum() > 500:
        net = ((a["FlowOutExNtv"] - a["FlowInExNtv"]).rolling(7).sum() / a["SplyCur"])
        z = (net - net.rolling(365).mean()) / net.rolling(365).std()
        rules["R5 exchange net outflow z>0 -> long (lag 1d)"] = (z > 0).astype(float).shift(1)

    # R6  Combination: trend AND VIX falling
    rules["R6 trend AND VIX falling -> long"] = trend * vreg

    # R7  Trend, but stand aside 5d after a VIX 2B bottom (complacency breaks)
    evb = pd.Series(0.0, index=idx)
    evb.loc[evb.index.intersection(bot_days)] = 1.0
    risk_off = (evb.rolling(5, min_periods=1).max() > 0).astype(float)
    rules["R7 trend, flat 5d after VIX 2B bottom"] = trend * (1 - risk_off)
    return rules, top_days, bot_days


def event_study(px: pd.Series, days: pd.DatetimeIndex, horizons=(1, 3, 5, 10)) -> dict:
    out = {}
    for label, sl in (("IS", slice(START, "2020-12-31")), ("OOS", slice(SPLIT, None))):
        p = px.loc[sl]
        d = days[(days >= p.index[0]) & (days <= p.index[-1])].intersection(p.index)
        row = {}
        for h in horizons:
            f = p.shift(-h) / p - 1
            x = f.reindex(d).dropna()
            base = f.dropna()
            if len(x) < 5:
                row[h] = {"n": int(len(x))}
                continue
            draws = RNG.choice(base.to_numpy(), size=(5000, len(x))).mean(axis=1)
            row[h] = {"n": int(len(x)), "mean_bps": float(x.mean() * 1e4), "median_bps": float(x.median() * 1e4), "hit": float((x > 0).mean()),
                      "base_mean_bps": float(base.mean() * 1e4), "base_hit": float((base > 0).mean()), "p": float(((draws >= x.mean()).sum() + 1) / 5001)}
        out[label] = row
    return out


def main():
    vix = load_vix()
    report = {"data": {}, "assets": {}}
    for name in ("btc", "eth"):
        a = load_asset(name).loc[START:]
        px = a["PriceUSD"]
        report["data"][name] = {"from": str(px.index[0].date()), "to": str(px.index[-1].date()), "days": int(len(px))}
        rules, tops, bots = build_rules(a, vix)
        rows = [evaluate(n, p, px) for n, p in rules.items()]
        report["assets"][name] = {"rules": rows, "vix2b_top_event": event_study(px, tops), "vix2b_bottom_event": event_study(px, bots)}
    report["data"]["vix"] = {"from": str(vix.index[0].date()), "to": str(vix.index[-1].date())}
    OUT.mkdir(exist_ok=True)
    (OUT / "edge_search.json").write_text(json.dumps(report, indent=2))

    def pct(x): return "  n/a " if x is None else f"{x*100:6.1f}%"
    for name, blk in report["assets"].items():
        print(f"\n=== {name.upper()}  ({report['data'][name]['from']} .. {report['data'][name]['to']}) ===")
        print(f"{'rule':44s} {'smp':3s} {'CAGR':>7s} {'Sharpe':>6s} {'MaxDD':>7s} {'expo':>5s} {'tr/yr':>5s} | {'B&H CAGR':>8s} {'B&H Sh':>6s} {'B&H DD':>7s} | p(timing)")
        for r in blk["rules"]:
            for s in ("IS", "OOS"):
                x = r[s]
                print(f"{r['rule'][:44]:44s} {s:3s} {pct(x.get('cagr'))} {x.get('sharpe', 0):6.2f} {pct(x.get('max_dd'))} {x['exposure']*100:4.0f}% {x['trades_per_yr']:5.1f} | {pct(x['bh_cagr']):>8s} {x['bh_sharpe']:6.2f} {pct(x['bh_max_dd'])} | {x['p_timing']:.3f}")
        for key, title in (("vix2b_top_event", "VIX 2B TOP -> fwd return"), ("vix2b_bottom_event", "VIX 2B BOTTOM -> fwd return")):
            print(f"  {title}")
            for s in ("IS", "OOS"):
                parts = []
                for h, v in blk[key][s].items():
                    parts.append(f"{h}d n={v['n']} mean={v.get('mean_bps', float('nan')):.0f}bp (base {v.get('base_mean_bps', float('nan')):.0f}) hit={v.get('hit', float('nan')):.0%} p={v.get('p', float('nan')):.3f}")
                print(f"    {s}: " + " | ".join(parts))


if __name__ == "__main__":
    sys.exit(main())

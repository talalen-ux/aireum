"""Walk-forward backtesting with realistic costs, baselines and calibration metrics.

Execution model (point-in-time)
  * A signal produced on bar t is executed at the OPEN of bar t+1 (the first price observable
    after the information existed). Exits at the open of bar t+1+H, or intrabar at the ATR stop /
    target (stop assumed hit first if both are touched in one bar — pessimistic).
  * One position at a time; signals while in a position are skipped (no pyramiding).

Costs per round trip (bps of notional)
  2 * (half_spread + taker_fee + slippage) + adverse_selection + funding accrual.
  slippage = base_slip + impact_k * 100 * sqrt(notional / bar_dollar_volume)   bps (square-root impact law).
  funding: longs PAY positive funding; accrued pro rata over the holding time on 8h-normalized rates.
  Stop failures: stop exits fill at the worse of (stop price, bar open) — gaps through stops are charged.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd


@dataclass
class Costs:
    half_spread_bps: float = 0.5
    taker_fee_bps: float = 4.0
    base_slip_bps: float = 0.5
    impact_k: float = 0.1
    adverse_selection_bps: float = 1.0
    notional_usd: float = 250_000.0
    funding: bool = True

    @staticmethod
    def zero() -> "Costs":
        return Costs(0, 0, 0, 0, 0, 250_000.0, False)


@dataclass
class ExitRule:
    horizon: int = 24                # bars
    stop_atr: float | None = None    # e.g. 1.5
    target_atr: float | None = None  # e.g. 3.0


@dataclass
class Trade:
    i_signal: int
    i_entry: int
    i_exit: int
    side: int
    entry: float
    exit: float
    gross_bps: float
    cost_bps: float
    net_bps: float
    reason: str


def run_trades(f: pd.DataFrame, signal: np.ndarray, rule: ExitRule, costs: Costs, atr: np.ndarray,
               bar_hours: float = 5 / 60, idx_range: tuple[int, int] | None = None) -> list[Trade]:
    o, h, l, c = (f[k].to_numpy() for k in ("open", "high", "low", "close"))
    dv = (f["volume"] * f["close"]).to_numpy()
    fr = f["funding_rate"].fillna(0).to_numpy() if costs.funding else np.zeros(len(f))
    lo, hi = idx_range or (0, len(f))
    trades: list[Trade] = []
    i = lo
    n = len(f)
    while i < hi:
        s = int(signal[i])
        if s == 0 or i + 1 >= n or not np.isfinite(atr[i]):
            i += 1
            continue
        e = i + 1
        entry = o[e]
        stop = entry - s * rule.stop_atr * atr[i] if rule.stop_atr else None
        tgt = entry + s * rule.target_atr * atr[i] if rule.target_atr else None
        last = min(e + rule.horizon, n - 1)
        exit_px, reason, j = o[last], "horizon", last
        for k in range(e, last):
            if stop is not None and ((s > 0 and l[k] <= stop) or (s < 0 and h[k] >= stop)):
                # gap-through: if the bar opened beyond the stop we fill at the open (stop failure)
                exit_px = min(stop, o[k]) if s > 0 else max(stop, o[k])
                reason, j = "stop", k
                break
            if tgt is not None and ((s > 0 and h[k] >= tgt) or (s < 0 and l[k] <= tgt)):
                exit_px, reason, j = tgt, "target", k
                break
        gross = s * np.log(exit_px / entry) * 1e4
        slip = costs.base_slip_bps + costs.impact_k * 100 * np.sqrt(costs.notional_usd / max(dv[e], 1.0))
        per_side = costs.half_spread_bps + costs.taker_fee_bps + slip
        held_h = (j - e + 1) * bar_hours
        funding_bps = s * float(np.mean(fr[e:j + 1])) * (held_h / 8.0) * 1e4 if costs.funding else 0.0
        cost = 2 * per_side + costs.adverse_selection_bps + funding_bps
        trades.append(Trade(i, e, j, s, float(entry), float(exit_px), float(gross), float(cost), float(gross - cost), reason))
        i = j + 1
    return trades


# --------------------------------------------------------------------------------- splits

@dataclass
class Split:
    train: np.ndarray
    test: np.ndarray


def walk_forward_splits(n: int, n_splits: int = 5, min_train: int | None = None, purge: int = 24,
                        embargo: int = 24, mode: str = "expanding", train_size: int | None = None) -> list[Split]:
    """Forward-only splits. Train ends `purge` bars before test starts (label horizon overlap);
    the first `embargo` bars of each test block are dropped so serially correlated features
    straddling the boundary cannot leak."""
    min_train = min_train or n // (n_splits + 1)
    test_len = (n - min_train) // n_splits
    out = []
    for k in range(n_splits):
        t0 = min_train + k * test_len
        t1 = n if k == n_splits - 1 else t0 + test_len
        tr_end = t0 - purge
        tr_start = 0 if mode == "expanding" else max(0, tr_end - (train_size or min_train))
        out.append(Split(np.arange(tr_start, tr_end), np.arange(t0 + embargo, t1)))
    return out


# --------------------------------------------------------------------------------- labels & metrics

def triple_barrier_labels(f: pd.DataFrame, atr: np.ndarray, side: int, horizon: int, k: float = 2.0) -> np.ndarray:
    """1 if, entering at next open, price reaches +k*ATR (in `side` direction) before -k*ATR within horizon."""
    o, h, l = f["open"].to_numpy(), f["high"].to_numpy(), f["low"].to_numpy()
    n = len(f)
    y = np.full(n, np.nan)
    for i in range(n - 1):
        if not np.isfinite(atr[i]):
            continue
        e = i + 1
        up, dn = o[e] + k * atr[i], o[e] - k * atr[i]
        res = 0.0
        for j in range(e, min(e + horizon, n)):
            hit_up, hit_dn = h[j] >= up, l[j] <= dn
            if side > 0:
                if hit_dn:
                    break
                if hit_up:
                    res = 1.0
                    break
            else:
                if hit_up:
                    break
                if hit_dn:
                    res = 1.0
                    break
        y[i] = res
    return y


def max_drawdown(pnl_bps: np.ndarray) -> float:
    if len(pnl_bps) == 0:
        return 0.0
    eq = np.cumsum(pnl_bps)
    return float(np.max(np.maximum.accumulate(np.r_[0, eq])[1:] - eq, initial=0.0))


def bootstrap_ci(x: np.ndarray, n_boot: int = 2000, alpha: float = 0.05, seed: int = 0) -> tuple[float, float]:
    if len(x) < 2:
        return (float("nan"), float("nan"))
    rng = np.random.default_rng(seed)
    means = rng.choice(x, size=(n_boot, len(x)), replace=True).mean(1)
    return float(np.quantile(means, alpha / 2)), float(np.quantile(means, 1 - alpha / 2))


def brier(p: np.ndarray, y: np.ndarray) -> float:
    return float(np.mean((p - y) ** 2)) if len(p) else float("nan")


def reliability_bins(p: np.ndarray, y: np.ndarray, bins: int = 10) -> list[dict]:
    edges = np.linspace(0, 1, bins + 1)
    out = []
    for a, b in zip(edges[:-1], edges[1:]):
        m = (p >= a) & (p < b if b < 1 else p <= b)
        if m.any():
            out.append({"bin": f"{a:.1f}-{b:.1f}", "n": int(m.sum()), "mean_pred": float(p[m].mean()), "freq": float(y[m].mean())})
    return out


def fit_logistic(X: np.ndarray, y: np.ndarray, l2: float = 1.0, iters: int = 500, lr: float = 0.1):
    """Tiny L2-regularized logistic regression (standardized inputs). Fit on TRAIN events only."""
    mu, sd = X.mean(0), X.std(0) + 1e-9
    Z = (X - mu) / sd
    w = np.zeros(Z.shape[1])
    b = float(np.log((y.mean() + 1e-3) / (1 - y.mean() + 1e-3)))
    for _ in range(iters):
        p = 1 / (1 + np.exp(-(Z @ w + b)))
        g = p - y
        w -= lr * (Z.T @ g / len(y) + l2 * w / len(y))
        b -= lr * g.mean()
    return lambda Xn: 1 / (1 + np.exp(-(((Xn - mu) / sd) @ w + b)))


def deflated_sharpe(sr: float, n_obs: int, n_trials: int, skew: float = 0.0, kurt: float = 3.0, sr_var: float | None = None) -> float:
    """Probability the true Sharpe > 0 after accounting for `n_trials` tried configurations
    (Bailey & López de Prado, 2014). sr is per-observation (non-annualized)."""
    from scipy.stats import norm
    if n_obs < 3:
        return float("nan")
    emc = 0.5772156649
    sr_var = sr_var if sr_var is not None else 1.0 / n_obs
    sr0 = np.sqrt(sr_var) * ((1 - emc) * norm.ppf(1 - 1 / max(n_trials, 2)) + emc * norm.ppf(1 - 1 / (max(n_trials, 2) * np.e)))
    den = np.sqrt(max(1e-12, 1 - skew * sr + (kurt - 1) / 4 * sr ** 2))
    return float(norm.cdf((sr - sr0) * np.sqrt(n_obs - 1) / den))


@dataclass
class StrategyResult:
    name: str
    trades: list[Trade] = field(default_factory=list)

    def metrics(self, days: float) -> dict:
        net = np.array([t.net_bps for t in self.trades])
        gross = np.array([t.gross_bps for t in self.trades])
        n = len(net)
        if n == 0:
            return {"name": self.name, "n_trades": 0, "expectancy_bps": 0.0, "gross_bps": 0.0, "hit_rate": None,
                    "total_bps": 0.0, "max_dd_bps": 0.0, "turnover_per_day": 0.0, "sharpe_per_trade": None,
                    "expectancy_ci95": [None, None]}
        sd = net.std(ddof=1) if n > 1 else float("nan")
        lo, hi = bootstrap_ci(net)
        return {
            "name": self.name, "n_trades": n,
            "expectancy_bps": float(net.mean()), "gross_bps": float(gross.mean()),
            "expectancy_ci95": [lo, hi],
            "hit_rate": float((net > 0).mean()), "total_bps": float(net.sum()),
            "max_dd_bps": max_drawdown(net), "turnover_per_day": n / max(days, 1e-9),
            "sharpe_per_trade": float(net.mean() / sd) if sd and sd > 0 else None,
            "stop_rate": float(np.mean([t.reason == "stop" for t in self.trades])),
        }


# --------------------------------------------------------------------------------- baselines

def baseline_random(n: int, n_signals: int, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    sig = np.zeros(n, dtype=int)
    if n_signals > 0:
        idx = rng.choice(n, size=min(n_signals, n), replace=False)
        sig[idx] = rng.choice([-1, 1], size=len(idx))
    return sig


def baseline_mean_reversion(feat: pd.DataFrame, z: float = 2.0, cooldown: int = 24) -> np.ndarray:
    x = feat["z_ret_sum"].to_numpy()
    return _edge(np.where(x <= -z, 1, np.where(x >= z, -1, 0)), cooldown)


def baseline_momentum(feat: pd.DataFrame, z: float = 2.0, cooldown: int = 24) -> np.ndarray:
    return -baseline_mean_reversion(feat, z, cooldown)


def _edge(raw: np.ndarray, cooldown: int) -> np.ndarray:
    out = np.zeros_like(raw)
    last = -10**9
    prev = 0
    for i, v in enumerate(raw):
        if v != 0 and v != prev and i - last >= cooldown:
            out[i] = v
            last = i
        prev = v
    return out

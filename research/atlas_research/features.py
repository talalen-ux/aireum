"""Feature definitions — mirror of the ATLAS TypeScript engine.

All rolling statistics are strictly PAST-ONLY: the value at bar t uses bars <= t, and the
normalization history for z-scores uses bars in [t-W, t-1] (the current value is scored
against a history that excludes it). No centered windows, no full-sample statistics.

Definitions (bar index t, window w):
  signed_t        = aggressive buy volume - aggressive sell volume (base units)
  cvd_t           = sum_{i<=t} signed_i
  cvd_slope_t     = OLS slope of cvd over bars [t-w+1, t] vs. bar index        (units / bar)
  ret_bps_t       = 1e4 * ln(close_t / close_{t-1})
  kyle_lambda_t   = sum(ret_bps * signed) / sum(signed^2) over [t-w+1, t]       (through-origin OLS:
                    bps of price move per unit of aggressive flow. Robust to persistent one-sided
                    flow, where an intercept would absorb the effect.)
  impact_decay_t  = ln( max(lambda_short_t, eps) / lambda_prev_t )  where lambda_short is kyle_lambda over the
                    last w_lambda/2 bars and lambda_prev is kyle_lambda over the w_lambda bars BEFORE that
                    (non-overlapping). < ln(0.5) means price moves less than half as much per unit of
                    aggression as it did in the preceding window. NaN when lambda_prev <= 0.
  oi_chg_t        = ln(oi_t / oi_{t-w})
  spot_perp_div_t = z(spot_cvd_slope)_t - z(perp_cvd_slope)_t
  absorption_t    = |z(signed)_t| / max(|z(ret_bps)_t|, eps)  — much aggressive flow, little movement
  robust_z(x)_t   = (x_t - median(x[t-W:t])) / (1.4826 * MAD(x[t-W:t])), clipped to ±6
  atr_t           = mean true range over [t-w+1, t]
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view

Z_CLIP = 6.0


def robust_z(x: pd.Series | np.ndarray, window: int = 288, min_periods: int = 60) -> np.ndarray:
    """Past-only robust z-score. History for bar t is x[t-window : t] (excludes t)."""
    a = np.asarray(x, dtype=float)
    n = len(a)
    out = np.full(n, np.nan)
    if n <= min_periods:
        return out
    padded = np.r_[np.full(window, np.nan), a]
    # windows[k] = padded[k : k+window] = a[k-window : k]  -> history strictly before bar k
    win = sliding_window_view(padded, window)[:n]
    with np.errstate(all="ignore"):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            cnt = np.sum(~np.isnan(win), axis=1)
            med = np.nanmedian(win, axis=1)
            mad = 1.4826 * np.nanmedian(np.abs(win - med[:, None]), axis=1)
            std = np.nanstd(win, axis=1)
    scale = np.where(mad > 0, mad, std)
    ok = (cnt >= min_periods) & (scale > 0) & np.isfinite(a)
    out[ok] = np.clip((a[ok] - med[ok]) / scale[ok], -Z_CLIP, Z_CLIP)
    return out


def rolling_slope(y: pd.Series, w: int) -> pd.Series:
    """OLS slope of y on bar index over a trailing window (inclusive of t)."""
    t = pd.Series(np.arange(len(y), dtype=float), index=y.index)
    cov = (t * y).rolling(w, min_periods=w).mean() - t.rolling(w).mean() * y.rolling(w, min_periods=w).mean()
    var = t.rolling(w).var(ddof=0)
    return cov / var


def kyle_lambda(ret_bps: pd.Series, signed: pd.Series, w: int) -> pd.Series:
    num = (ret_bps * signed).rolling(w, min_periods=w).sum()
    den = (signed ** 2).rolling(w, min_periods=w).sum()
    return num / den.where(den > 0)


def atr(f: pd.DataFrame, w: int = 14) -> pd.Series:
    pc = f["close"].shift(1)
    tr = pd.concat([f["high"] - f["low"], (f["high"] - pc).abs(), (f["low"] - pc).abs()], axis=1).max(axis=1)
    return tr.rolling(w, min_periods=w).mean()


def compute_features(f: pd.DataFrame, w_flow: int = 12, w_lambda: int = 24, w_oi: int = 12,
                     z_window: int = 288, z_min: int = 60) -> pd.DataFrame:
    """Compute the full feature panel. Returns a new frame aligned to ``f.index``."""
    out = pd.DataFrame(index=f.index)
    ret = 1e4 * np.log(f["close"] / f["close"].shift(1))
    out["ret_bps"] = ret
    out["perp_signed"] = f["perp_signed"]
    out["perp_cvd"] = f["perp_signed"].cumsum()
    out["perp_cvd_slope"] = rolling_slope(out["perp_cvd"], w_flow)
    has_spot = f["spot_signed"].notna().any()
    if has_spot:
        out["spot_cvd"] = f["spot_signed"].fillna(0).cumsum()
        out["spot_cvd_slope"] = rolling_slope(out["spot_cvd"], w_flow)
    else:
        out["spot_cvd"] = out["spot_cvd_slope"] = np.nan
    out["kyle_lambda"] = kyle_lambda(ret, f["perp_signed"], w_lambda)
    half = max(2, w_lambda // 2)
    lam_short = kyle_lambda(ret, f["perp_signed"], half)
    lam_prev = out["kyle_lambda"].shift(half)
    out["impact_decay"] = np.log(np.maximum(lam_short, 1e-6) / lam_prev.where(lam_prev > 0))
    out["oi_chg"] = np.log(f["oi"] / f["oi"].shift(w_oi)) if f["oi"].notna().any() else np.nan
    out["funding_rate"] = f["funding_rate"]
    out["atr"] = atr(f)
    out["realized_vol"] = ret.rolling(288, min_periods=48).std()

    z = lambda s: robust_z(s, z_window, z_min)  # noqa: E731
    out["z_perp_cvd_slope"] = z(out["perp_cvd_slope"])
    out["z_spot_cvd_slope"] = z(out["spot_cvd_slope"]) if has_spot else np.nan
    out["z_lambda"] = z(out["kyle_lambda"])
    out["z_lambda_delta"] = out["z_lambda"] - out["z_lambda"].shift(w_lambda // 2)
    out["z_oi_chg"] = z(out["oi_chg"]) if np.isfinite(out["oi_chg"]).any() else np.nan
    out["spot_perp_div"] = out["z_spot_cvd_slope"] - out["z_perp_cvd_slope"]
    z_sig = z(f["perp_signed"])
    z_ret = z(ret)
    out["absorption"] = np.abs(z_sig) / np.maximum(np.abs(z_ret), 0.25)
    out["z_ret_sum"] = z(ret.rolling(w_flow, min_periods=w_flow).sum())
    return out


FEATURE_DOCS = {
    "perp_cvd_slope": "OLS slope of perp CVD over w_flow bars (base units/bar)",
    "spot_cvd_slope": "OLS slope of spot CVD over w_flow bars",
    "kyle_lambda": "through-origin OLS of bar return (bps) on perp signed flow over w_lambda bars",
    "z_lambda_delta": "change in robust-z(kyle_lambda) vs w_lambda/2 bars earlier (impact weakening < 0)",
    "impact_decay": "ln(lambda over last w/2 bars / lambda over the preceding w bars); < ln 0.5 = impact halved",
    "oi_chg": "log change of open interest over w_oi bars",
    "spot_perp_div": "z(spot CVD slope) - z(perp CVD slope)",
    "absorption": "|z(perp signed)| / max(|z(ret)|, 0.25)",
}

"""Data loading: Binance public data dumps -> point-in-time bar frames.

Supported dumps (https://data.binance.vision):
  spot   aggTrades : data/spot/{daily|monthly}/aggTrades/{SYMBOL}/{SYMBOL}-aggTrades-{DATE}.zip
  perp   aggTrades : data/futures/um/{daily|monthly}/aggTrades/{SYMBOL}/{SYMBOL}-aggTrades-{DATE}.zip
  perp   metrics   : data/futures/um/daily/metrics/{SYMBOL}/{SYMBOL}-metrics-{YYYY-MM-DD}.zip   (5m OI snapshots)
  perp   funding   : data/futures/um/monthly/fundingRate/{SYMBOL}/{SYMBOL}-fundingRate-{YYYY-MM}.zip
  klines           : data/{spot|futures/um}/daily/klines/{SYMBOL}/{INTERVAL}/{SYMBOL}-{INTERVAL}-{DATE}.zip

Point-in-time rules
  * A bar labelled ``t`` covers trades in [t, t+freq) and is only *known* at t+freq.
    All features computed at bar t use data up to and including bar t; decisions taken
    on bar t are executed at the OPEN of bar t+1 (see backtest.py).
  * Metrics/funding snapshots are joined with ``merge_asof(direction="backward")`` on the
    bar CLOSE time, so a snapshot is only used once it existed.

The frame columns used everywhere downstream:
  open high low close volume            perp OHLCV (base units)
  perp_buy perp_sell perp_signed         aggressive volume split by aggressor (base units)
  spot_close spot_buy spot_sell spot_signed
  oi                                     perp open interest, base units (NaN if unavailable)
  funding_rate                           last known funding rate per 8h-equivalent (fraction)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pandas as pd

AGG_COLS = [
    "agg_trade_id", "price", "quantity", "first_trade_id", "last_trade_id",
    "transact_time", "is_buyer_maker", "is_best_match",
]


def _to_datetime_ms_or_us(ts: pd.Series) -> pd.Series:
    """Binance spot dumps switched from ms to µs timestamps in 2025; detect by magnitude."""
    ts = pd.to_numeric(ts)
    unit = "us" if ts.iloc[0] > 1e14 else "ms"
    return pd.to_datetime(ts, unit=unit, utc=True)


def load_agg_trades(path: str | Path) -> pd.DataFrame:
    """Load a Binance aggTrades CSV (or .zip containing one). Handles header/no-header variants.

    Returns columns: ts (UTC), price, qty, side (+1 aggressive buy, -1 aggressive sell).
    ``is_buyer_maker == True`` means the buyer was passive => the aggressor SOLD.
    """
    path = Path(path)
    head = pd.read_csv(path, nrows=1, header=None)
    has_header = isinstance(head.iloc[0, 0], str) and not str(head.iloc[0, 0]).isdigit()
    df = pd.read_csv(path, header=0 if has_header else None)
    if not has_header:
        df.columns = AGG_COLS[: df.shape[1]]
    bm = df["is_buyer_maker"]
    if bm.dtype != bool:
        bm = bm.astype(str).str.lower().isin(["true", "1"])
    out = pd.DataFrame({
        "ts": _to_datetime_ms_or_us(df["transact_time"]),
        "price": df["price"].astype(float),
        "qty": df["quantity"].astype(float),
        "side": np.where(bm, -1, 1),
    })
    # Duplicate agg ids happen when daily files overlap; drop them deterministically.
    if "agg_trade_id" in df:
        out = out.loc[~df["agg_trade_id"].duplicated().to_numpy()]
    return out.sort_values("ts", kind="stable").reset_index(drop=True)


def trades_to_bars(trades: pd.DataFrame, freq: str = "5min") -> pd.DataFrame:
    """Aggregate trades into OHLCV bars with aggressor-split volume. Bars are left-labelled."""
    t = trades.set_index("ts")
    buy = t["qty"].where(t["side"] > 0, 0.0)
    sell = t["qty"].where(t["side"] < 0, 0.0)
    g = t["price"].resample(freq, label="left", closed="left")
    bars = pd.DataFrame({
        "open": g.first(), "high": g.max(), "low": g.min(), "close": g.last(),
        "volume": t["qty"].resample(freq).sum(),
        "buy": buy.resample(freq).sum(), "sell": sell.resample(freq).sum(),
        "n_trades": t["qty"].resample(freq).count(),
    })
    # Empty bars: carry close forward, zero volume (never interpolate prices).
    bars["close"] = bars["close"].ffill()
    for c in ("open", "high", "low"):
        bars[c] = bars[c].fillna(bars["close"])
    bars["signed"] = bars["buy"] - bars["sell"]
    return bars


def load_metrics(path: str | Path) -> pd.DataFrame:
    """Binance UM futures `metrics` dump (5m): create_time,symbol,sum_open_interest,sum_open_interest_value,..."""
    df = pd.read_csv(path)
    df["ts"] = pd.to_datetime(df["create_time"], utc=True)
    return df[["ts", "sum_open_interest", "sum_open_interest_value"]].rename(
        columns={"sum_open_interest": "oi", "sum_open_interest_value": "oi_usd"}
    ).sort_values("ts")


def load_funding(path: str | Path) -> pd.DataFrame:
    """Binance UM `fundingRate` dump: calc_time,funding_interval_hours,last_funding_rate."""
    df = pd.read_csv(path)
    df["ts"] = pd.to_datetime(pd.to_numeric(df["calc_time"]), unit="ms", utc=True)
    hours = df.get("funding_interval_hours", pd.Series(8, index=df.index)).astype(float)
    # Normalize to an 8h-equivalent rate so venues/intervals are comparable.
    df["funding_rate"] = df["last_funding_rate"].astype(float) * (8.0 / hours)
    return df[["ts", "funding_rate"]].sort_values("ts")


def build_frame(perp_bars: pd.DataFrame, spot_bars: pd.DataFrame | None = None,
                metrics: pd.DataFrame | None = None, funding: pd.DataFrame | None = None,
                freq: str = "5min") -> pd.DataFrame:
    """Join perp + spot bars with OI/funding using strictly backward (point-in-time) as-of joins."""
    f = pd.DataFrame(index=perp_bars.index)
    for c in ("open", "high", "low", "close", "volume"):
        f[c] = perp_bars[c]
    f["perp_buy"], f["perp_sell"], f["perp_signed"] = perp_bars["buy"], perp_bars["sell"], perp_bars["signed"]
    if spot_bars is not None:
        s = spot_bars.reindex(f.index)
        f["spot_close"] = s["close"].ffill()
        f["spot_buy"], f["spot_sell"] = s["buy"].fillna(0), s["sell"].fillna(0)
        f["spot_signed"] = f["spot_buy"] - f["spot_sell"]
    else:
        f["spot_close"] = np.nan
        f["spot_buy"] = f["spot_sell"] = f["spot_signed"] = np.nan
    close_time = f.index + pd.Timedelta(freq)
    key = pd.DataFrame({"close_time": close_time}, index=f.index)
    for extra, cols in ((metrics, ["oi"]), (funding, ["funding_rate"])):
        if extra is None:
            for c in cols:
                f[c] = np.nan
            continue
        j = pd.merge_asof(key.reset_index().sort_values("close_time"), extra.rename(columns={"ts": "close_time"}),
                          on="close_time", direction="backward")
        for c in cols:
            f[c] = j[c].to_numpy()
    f.attrs["synthetic"] = False
    return f


def load_binance_dir(data_dir: str | Path, symbol: str = "BTCUSDT", freq: str = "5min") -> pd.DataFrame:
    """Load every extracted CSV in ``data_dir`` laid out as:
        {data_dir}/perp/aggTrades/*.csv, {data_dir}/spot/aggTrades/*.csv,
        {data_dir}/perp/metrics/*.csv,   {data_dir}/perp/fundingRate/*.csv
    """
    d = Path(data_dir)

    def cat(pattern: str, loader):
        files = sorted(d.glob(pattern))
        return pd.concat([loader(p) for p in files], ignore_index=True) if files else None

    perp_tr = cat("perp/aggTrades/*.csv", load_agg_trades)
    if perp_tr is None:
        raise FileNotFoundError(f"no perp aggTrades CSVs under {d}/perp/aggTrades")
    spot_tr = cat("spot/aggTrades/*.csv", load_agg_trades)
    metrics = cat("perp/metrics/*.csv", load_metrics)
    funding = cat("perp/fundingRate/*.csv", load_funding)
    return build_frame(trades_to_bars(perp_tr, freq), trades_to_bars(spot_tr, freq) if spot_tr is not None else None,
                       metrics, funding, freq)


# ---------------------------------------------------------------------------------------------
# Synthetic data — FOR TESTS ONLY. Frames carry attrs["synthetic"] = True and reports say so.
# ---------------------------------------------------------------------------------------------

@dataclass
class Episode:
    kind: str          # "down_exhaustion" | "up_exhaustion" | "down_decoy" | "up_decoy"
    start: int         # bar index of the initial impulse
    exhaustion: int    # first bar of the exhaustion phase
    reversal: int      # first bar of the reversal phase
    end: int


@dataclass
class SyntheticMarket:
    frame: pd.DataFrame
    episodes: list[Episode] = field(default_factory=list)


def synthetic_frame(n: int = 20_000, seed: int = 7, n_episodes: int = 40, decoy_ratio: float = 0.5,
                    freq: str = "5min", base_price: float = 60_000.0) -> SyntheticMarket:
    """Generate a 5m perp+spot market with planted exhaustion episodes and look-alike decoys.

    Exhaustion episode (downside; upside is symmetric):
      A impulse   (24 bars): heavy perp + spot selling, normal impact -> price falls.
      B exhaust   (24 bars): perp selling PERSISTS, impact per unit flow decays to ~20%,
                             OI contracts, spot selling subsides.
      C reversal  (36 bars): flow flips, price recovers.
    Decoy (continuation): same impulse, but phase B keeps full impact, OI rises, spot keeps selling,
    and phase C continues in the impulse direction. A detector with real discriminating power
    must fire on exhaustion episodes and NOT on decoys.
    """
    rng = np.random.default_rng(seed)
    q = rng.normal(0, 30, n)                # perp signed flow (base units)
    qs = 0.35 * q + rng.normal(0, 8, n)     # spot signed flow, partly correlated
    lam = np.full(n, 0.6)                   # bps per unit flow
    oi_d = rng.normal(0, 0.0004, n)         # OI log changes
    noise = rng.normal(0, 4.0, n)           # bps
    fr = np.full(n, 0.0001)

    episodes: list[Episode] = []
    LA, LB, LC = 24, 24, 36
    span = LA + LB + LC
    slots = np.linspace(400, n - span - 50, n_episodes).astype(int)
    for i, s in enumerate(slots):
        s = int(s + rng.integers(-100, 100))
        down = (i % 2 == 0)
        decoy = rng.random() < decoy_ratio
        sg = -1.0 if down else 1.0
        a, b, c = s, s + LA, s + LA + LB
        q[a:b] += sg * 70
        qs[a:b] += sg * 25
        oi_d[a:b] += -0.0008 if not decoy else 0.0010
        if not decoy:
            q[b:c] += sg * 55                       # aggression persists...
            lam[b:c] = 0.12                         # ...but moves price far less
            qs[b:c] = 0.05 * qs[b:c] + rng.normal(0, 4, LB)  # spot selling subsides
            oi_d[b:c] += -0.004                     # OI contracts (forced closes)
            fr[a:c] = 0.0002 * sg                     # funding leans with the crowd
            q[c:c + LC] += -sg * 45                 # reversal flow
            qs[c:c + LC] += -sg * 15
            kind = ("down" if down else "up") + "_exhaustion"
        else:
            q[b:c] += sg * 55
            lam[b:c] = 0.7                          # impact stays high
            qs[b:c] += sg * 25                      # spot keeps selling
            oi_d[b:c] += 0.0015                     # new positions opening
            q[c:c + LC] += sg * 35                  # continuation
            kind = ("down" if down else "up") + "_decoy"
        episodes.append(Episode(kind, a, b, c, c + LC))

    r_bps = lam * q / 10.0 + noise
    logp = np.log(base_price) + np.cumsum(r_bps) / 1e4
    close = np.exp(logp)
    open_ = np.r_[base_price, close[:-1]]
    wick = np.abs(rng.normal(0, 3, n)) / 1e4
    high = np.maximum(open_, close) * (1 + wick)
    low = np.minimum(open_, close) * (1 - wick)
    vol = np.abs(q) + np.abs(rng.normal(80, 20, n))
    perp_buy = (vol + q) / 2
    perp_sell = (vol - q) / 2
    svol = np.abs(qs) + np.abs(rng.normal(30, 8, n))
    idx = pd.date_range("2024-01-01", periods=n, freq=freq, tz="UTC")
    f = pd.DataFrame({
        "open": open_, "high": high, "low": low, "close": close, "volume": vol,
        "perp_buy": perp_buy, "perp_sell": perp_sell, "perp_signed": q,
        "spot_close": close * (1 + rng.normal(0, 1e-4, n)),
        "spot_buy": (svol + qs) / 2, "spot_sell": (svol - qs) / 2, "spot_signed": qs,
        "oi": 80_000 * np.exp(np.cumsum(oi_d)),
        "funding_rate": fr,
    }, index=idx)
    f.attrs["synthetic"] = True
    return SyntheticMarket(f, episodes)

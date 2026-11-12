"""Liquidity Exhaustion & Reversal detector (research mirror of the ATLAS engine).

Downside exhaustion -> LONG hypothesis, all conditions on bar t (point-in-time):
  1. selling persists          z(perp CVD slope) <= -persist_z
  2. impact weakening          impact_decay       <= ln(impact_ratio)  (price moves < impact_ratio as much per
                                                                       unit of aggression as in the preceding window)
  3. OI contracting            z(oi_chg)          <= -oi_z          (forced/voluntary closing, not new shorts)
  4. spot selling subsides     z(spot slope) - z(perp slope) >= spot_div
  5. context: a decline exists (sum of last w returns z <= -context_z)
Upside exhaustion -> SHORT hypothesis is the exact mirror.

Missing inputs (e.g. no spot or no OI data) make the corresponding condition UNAVAILABLE; the
detector then requires ``min_conditions`` of the available ones and reports which were missing.
It never substitutes a value. Events fire on the rising edge with a cooldown.

Invalidation: LONG invalid if price trades below (lowest low over `inval_lookback` bars) - k*ATR;
SHORT invalid above (highest high) + k*ATR.

This is a research hypothesis generator, not a bottom/top predictor.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd


@dataclass
class ExhaustionParams:
    persist_z: float = 1.0
    impact_ratio: float = 0.5
    oi_z: float = 0.5
    spot_div: float = 0.5
    context_z: float = 1.0
    min_conditions: int = 5          # of the available conditions (clamped to available count)
    cooldown: int = 24
    inval_lookback: int = 36
    inval_atr_k: float = 1.0


@dataclass
class ExhaustionEvent:
    ts: pd.Timestamp
    i: int
    side: str            # "long" (downside exhaustion) | "short" (upside exhaustion)
    score: float         # mean normalized margin of satisfied conditions (diagnostic, uncalibrated)
    n_conditions: int
    available: int
    price: float
    invalidation: float
    components: dict

    def to_dict(self):
        d = asdict(self)
        d["ts"] = self.ts.isoformat()
        return d


def _conditions(feat: pd.DataFrame, p: ExhaustionParams, sign: int) -> dict[str, np.ndarray]:
    """sign=-1 for downside exhaustion (long), +1 for upside (short). Returns margin arrays (>=0 means satisfied)."""
    s = sign
    return {
        "flow_persists": s * feat["z_perp_cvd_slope"].to_numpy() - p.persist_z,
        "impact_weakening": np.log(p.impact_ratio) - feat["impact_decay"].to_numpy(),
        "oi_contracting": -feat["z_oi_chg"].to_numpy() - p.oi_z if "z_oi_chg" in feat else np.full(len(feat), np.nan),
        "spot_subsiding": -s * feat["spot_perp_div"].to_numpy() - p.spot_div,
        "context_move": s * feat["z_ret_sum"].to_numpy() - p.context_z,
    }


def detect(f: pd.DataFrame, feat: pd.DataFrame, params: ExhaustionParams | None = None) -> list[ExhaustionEvent]:
    p = params or ExhaustionParams()
    events: list[ExhaustionEvent] = []
    lows = f["low"].rolling(p.inval_lookback, min_periods=1).min().to_numpy()
    highs = f["high"].rolling(p.inval_lookback, min_periods=1).max().to_numpy()
    atr = feat["atr"].to_numpy()
    close = f["close"].to_numpy()
    for side, sign in (("long", -1), ("short", 1)):
        cond = _conditions(feat, p, sign)
        m = np.vstack([np.asarray(v, dtype=float) for v in cond.values()])   # (k, n)
        avail = np.isfinite(m)
        sat = (m >= 0) & avail
        n_av = avail.sum(0)
        need = np.minimum(p.min_conditions, n_av)
        fire = (sat.sum(0) >= need) & (n_av >= 3) & np.isfinite(atr)
        last = -10**9
        prev = False
        for i in np.flatnonzero(fire | np.r_[False, fire[:-1]]):
            on = fire[i]
            if on and not prev and i - last >= p.cooldown:
                margins = np.where(sat[:, i], m[:, i], 0.0)
                score = float(np.mean(np.tanh(np.clip(margins, 0, None))))
                inval = lows[i] - p.inval_atr_k * atr[i] if side == "long" else highs[i] + p.inval_atr_k * atr[i]
                events.append(ExhaustionEvent(
                    ts=f.index[i], i=int(i), side=side, score=score, n_conditions=int(sat[:, i].sum()),
                    available=int(n_av[i]), price=float(close[i]), invalidation=float(inval),
                    components={k: (None if not np.isfinite(v[i]) else round(float(v[i]), 3)) for k, v in cond.items()},
                ))
                last = i
            prev = on
    events.sort(key=lambda e: e.i)
    return events


def events_to_signal(n: int, events: list[ExhaustionEvent]) -> np.ndarray:
    """+1 long / -1 short on the event bar, 0 elsewhere."""
    sig = np.zeros(n, dtype=int)
    for e in events:
        sig[e.i] = 1 if e.side == "long" else -1
    return sig


def feature_matrix(feat: pd.DataFrame, events: list[ExhaustionEvent]) -> np.ndarray:
    """Per-event feature vector used for walk-forward probability calibration."""
    rows = []
    for e in events:
        c = e.components
        rows.append([e.score, e.n_conditions / max(e.available, 1)] + [0.0 if c[k] is None else c[k] for k in sorted(c)])
    return np.asarray(rows, dtype=float).reshape(len(events), -1) if rows else np.zeros((0, 7))

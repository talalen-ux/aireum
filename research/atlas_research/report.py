"""Validation pipeline + markdown/JSON report rendering."""
from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

from . import backtest as bt
from .data import Episode
from .exhaustion import ExhaustionParams, detect, events_to_signal, feature_matrix
from .features import compute_features

EXIT_VARIANTS = {
    "H24": bt.ExitRule(horizon=24),
    "ATR1.5/3.0_H48": bt.ExitRule(horizon=48, stop_atr=1.5, target_atr=3.0),
}


def _reversal_onsets(f: pd.DataFrame, atr: np.ndarray, side: int, half: int = 36, horizon: int = 48, k: float = 3.0) -> np.ndarray:
    """Labeling only (uses the future by design): local extreme bars followed by a >= k*ATR move."""
    px = f["low"].to_numpy() if side > 0 else f["high"].to_numpy()
    s = pd.Series(px)
    ext = (s.rolling(2 * half + 1, center=True, min_periods=half).min() if side > 0
           else s.rolling(2 * half + 1, center=True, min_periods=half).max()).to_numpy()
    c = f["close"].to_numpy()
    out = []
    for i in np.flatnonzero(px == ext):
        if not np.isfinite(atr[i]) or i + horizon >= len(c):
            continue
        move = (np.max(c[i:i + horizon]) - px[i]) if side > 0 else (px[i] - np.min(c[i:i + horizon]))
        if move >= k * atr[i]:
            out.append(i)
    return np.asarray(out, dtype=int)


def run_validation(f: pd.DataFrame, episodes: list[Episode] | None = None, params: ExhaustionParams | None = None,
                   costs: bt.Costs | None = None, n_splits: int = 5, label_h: int = 48, label_k: float = 2.0,
                   n_random: int = 50, seed: int = 0) -> dict:
    params = params or ExhaustionParams()
    costs = costs or bt.Costs()
    feat = compute_features(f)
    atr = feat["atr"].to_numpy()
    events = detect(f, feat, params)
    sig = events_to_signal(len(f), events)
    labels = {+1: bt.triple_barrier_labels(f, atr, +1, label_h, label_k),
              -1: bt.triple_barrier_labels(f, atr, -1, label_h, label_k)}
    splits = bt.walk_forward_splits(len(f), n_splits=n_splits, purge=label_h, embargo=label_h)
    bar_minutes = (f.index[1] - f.index[0]).total_seconds() / 60
    bar_hours = bar_minutes / 60

    strategies = {"exhaustion": sig,
                  "mean_reversion": bt.baseline_mean_reversion(feat),
                  "momentum": bt.baseline_momentum(feat),
                  "always_flat": np.zeros(len(f), dtype=int)}

    per_variant: dict = {}
    for vname, rule in EXIT_VARIANTS.items():
        agg: dict[str, list[bt.Trade]] = {k: [] for k in strategies}
        agg_zero: list[bt.Trade] = []
        rand_exp: list[float] = []
        test_days = 0.0
        for sp in splits:
            rng_ = (int(sp.test[0]), int(sp.test[-1]) + 1)
            test_days += len(sp.test) * bar_minutes / 1440
            for k, s in strategies.items():
                agg[k] += bt.run_trades(f, s, rule, costs, atr, bar_hours, rng_)
            agg_zero += bt.run_trades(f, sig, rule, bt.Costs.zero(), atr, bar_hours, rng_)
        n_sig = int(np.count_nonzero(sig[np.concatenate([s.test for s in splits])]))
        test_mask = np.zeros(len(f), dtype=bool)
        test_mask[np.concatenate([s.test for s in splits])] = True
        for r in range(n_random):
            rs = bt.baseline_random(len(f), n_sig, seed + 1000 + r)
            rs[~test_mask] = 0
            tr = bt.run_trades(f, rs, rule, costs, atr, bar_hours)
            rand_exp.append(float(np.mean([t.net_bps for t in tr])) if tr else 0.0)
        res = {k: bt.StrategyResult(k, v).metrics(test_days) for k, v in agg.items()}
        res["exhaustion_zero_cost"] = bt.StrategyResult("exhaustion_zero_cost", agg_zero).metrics(test_days)
        res["random_matched"] = {"name": "random_matched", "draws": n_random, "n_signals_per_draw": n_sig,
                                 "expectancy_bps_mean": float(np.mean(rand_exp)),
                                 "expectancy_bps_p95": float(np.quantile(rand_exp, 0.95)),
                                 "exhaustion_percentile_vs_random": float(np.mean(np.array(rand_exp) < res["exhaustion"]["expectancy_bps"]))}
        # per-regime stability: realized-vol terciles with thresholds from the FIRST train block only
        rv = feat["realized_vol"].to_numpy()
        q1, q2 = np.nanquantile(rv[splits[0].train], [1 / 3, 2 / 3])
        reg = {}
        for name, cond in (("low_vol", lambda v: v < q1), ("mid_vol", lambda v: (v >= q1) & (v < q2)), ("high_vol", lambda v: v >= q2)):
            tr = [t for t in agg["exhaustion"] if np.isfinite(rv[t.i_signal]) and cond(rv[t.i_signal])]
            reg[name] = bt.StrategyResult(name, tr).metrics(test_days)
        res["exhaustion_by_regime"] = reg
        # deflated Sharpe: trials = detector config (1) x exit variants x strategies compared
        ex = agg["exhaustion"]
        if len(ex) > 2:
            net = np.array([t.net_bps for t in ex])
            from scipy.stats import kurtosis, skew
            sr = net.mean() / (net.std(ddof=1) + 1e-12)
            res["deflated_sharpe_prob"] = bt.deflated_sharpe(sr, len(net), n_trials=len(EXIT_VARIANTS) * len(strategies),
                                                             skew=float(skew(net)), kurt=float(kurtosis(net, fisher=False)))
        per_variant[vname] = res

    # ---- classification: precision / recall / calibration on test events only
    test_idx = np.concatenate([s.test for s in splits])
    test_set = set(test_idx.tolist())
    ev_test = [e for e in events if e.i in test_set]
    y_ev = np.array([labels[1 if e.side == "long" else -1][e.i] for e in ev_test])
    ok = np.isfinite(y_ev)
    precision = float(np.mean(y_ev[ok])) if ok.any() else None
    base_rate = {s: float(np.nanmean(labels[s][test_idx])) for s in (1, -1)}
    recall = {}
    for side, name in ((1, "long"), (-1, "short")):
        onsets = [i for i in _reversal_onsets(f, atr, side) if i in test_set]
        hits = sum(any(e.side == name and i - 12 <= e.i <= i + 6 for e in ev_test) for i in onsets)
        recall[name] = {"onsets": len(onsets), "detected": int(hits), "recall": (hits / len(onsets)) if onsets else None}

    probs, ys, clim = [], [], []
    for sp in splits:
        tr_ev = [e for e in events if sp.train[0] <= e.i <= sp.train[-1]]
        te_ev = [e for e in events if sp.test[0] <= e.i <= sp.test[-1]]
        ytr = np.array([labels[1 if e.side == "long" else -1][e.i] for e in tr_ev])
        yte = np.array([labels[1 if e.side == "long" else -1][e.i] for e in te_ev])
        mtr, mte = np.isfinite(ytr), np.isfinite(yte)
        if mtr.sum() < 10 or len(set(ytr[mtr])) < 2 or mte.sum() == 0:
            continue
        model = bt.fit_logistic(feature_matrix(feat, tr_ev)[mtr], ytr[mtr])
        probs.append(model(feature_matrix(feat, te_ev)[mte]))
        ys.append(yte[mte])
        clim.append(np.full(mte.sum(), ytr[mtr].mean()))
    calib = None
    if probs:
        p, y, c = np.concatenate(probs), np.concatenate(ys), np.concatenate(clim)
        calib = {"n": int(len(y)), "brier": bt.brier(p, y), "brier_climatology": bt.brier(c, y),
                 "skill_vs_climatology": 1 - bt.brier(p, y) / max(bt.brier(c, y), 1e-12),
                 "reliability": bt.reliability_bins(p, y)}

    episode_stats = None
    if episodes:
        def hit(ep: Episode, side: str):
            return any(e.side == side and ep.exhaustion <= e.i <= ep.reversal + 6 for e in events)
        side_of = lambda k: "long" if k.startswith("down") else "short"  # noqa: E731
        ex_eps = [ep for ep in episodes if ep.kind.endswith("exhaustion")]
        dc_eps = [ep for ep in episodes if ep.kind.endswith("decoy")]
        episode_stats = {
            "exhaustion_episodes": len(ex_eps), "exhaustion_detected": sum(hit(ep, side_of(ep.kind)) for ep in ex_eps),
            "decoy_episodes": len(dc_eps), "decoy_false_alarms": sum(hit(ep, side_of(ep.kind)) for ep in dc_eps),
        }

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "synthetic": bool(f.attrs.get("synthetic", False)),
        "bars": len(f), "start": f.index[0].isoformat(), "end": f.index[-1].isoformat(),
        "bar_minutes": bar_minutes,
        "params": asdict(params), "costs": asdict(costs),
        "splits": [{"train": [int(s.train[0]), int(s.train[-1])], "test": [int(s.test[0]), int(s.test[-1])]} for s in splits],
        "n_events_total": len(events), "n_events_test": len(ev_test),
        "classification": {"label": f"triple barrier ±{label_k}·ATR within {label_h} bars",
                           "precision": precision, "base_rate": {"long": base_rate[1], "short": base_rate[-1]},
                           "recall_major_reversals": recall, "calibration": calib},
        "episodes": episode_stats,
        "variants": per_variant,
        "sample_events": [e.to_dict() for e in ev_test[:10]],
    }


def _f(x, d=2):
    return "—" if x is None or (isinstance(x, float) and not np.isfinite(x)) else f"{x:.{d}f}"


def render_markdown(r: dict) -> str:
    L = []
    L.append("# ATLAS — Liquidity Exhaustion & Reversal: walk-forward validation report\n")
    if r["synthetic"]:
        L.append("> **SYNTHETIC DATA.** These results come from a generator with planted episodes. They verify that the "
                 "harness and detector behave as designed; they say **nothing** about real-market edge.\n")
    L.append("> No predictive edge is claimed until results are independently validated out of sample on real, point-in-time data.\n")
    L.append(f"- Generated: {r['generated_at']}\n- Data: {r['bars']} bars × {r['bar_minutes']:.0f}m, {r['start']} → {r['end']}")
    L.append(f"- Walk-forward: {len(r['splits'])} expanding splits, purge + embargo = label horizon")
    L.append(f"- Detector events: {r['n_events_total']} total, {r['n_events_test']} in test folds\n")
    c = r["classification"]
    L.append("## Classification (test folds only)\n")
    L.append(f"Label: {c['label']}.\n")
    L.append(f"- Precision of events: **{_f(c['precision'])}** vs unconditional base rate long {_f(c['base_rate']['long'])} / short {_f(c['base_rate']['short'])}")
    for s, v in c["recall_major_reversals"].items():
        L.append(f"- Recall of major {s} reversals (≥3·ATR from local extreme): {v['detected']}/{v['onsets']} = {_f(v['recall'])}")
    if c["calibration"]:
        cal = c["calibration"]
        L.append(f"- Calibration (logistic fit on train events, scored on test): Brier {_f(cal['brier'],4)} vs climatology "
                 f"{_f(cal['brier_climatology'],4)} → skill {_f(cal['skill_vs_climatology'],3)} (n={cal['n']})\n")
        L.append("| bin | n | mean predicted | observed freq |\n|---|---|---|---|")
        for b in cal["reliability"]:
            L.append(f"| {b['bin']} | {b['n']} | {_f(b['mean_pred'])} | {_f(b['freq'])} |")
    else:
        L.append("- Calibration: insufficient train events per fold to fit — reported as unavailable, not imputed.")
    if r["episodes"]:
        e = r["episodes"]
        L.append(f"\n## Planted episodes (synthetic)\n\n- Exhaustion detected: {e['exhaustion_detected']}/{e['exhaustion_episodes']}"
                 f"\n- False alarms on continuation decoys: {e['decoy_false_alarms']}/{e['decoy_episodes']}")
    for vname, res in r["variants"].items():
        L.append(f"\n## Trading results — exit `{vname}` (net of costs unless noted)\n")
        L.append("| strategy | trades | expectancy bps [95% CI] | gross bps | hit | total bps | max DD bps | trades/day |\n|---|---|---|---|---|---|---|---|")
        for k in ("exhaustion", "exhaustion_zero_cost", "mean_reversion", "momentum", "always_flat"):
            m = res[k]
            ci = m.get("expectancy_ci95", [None, None])
            L.append(f"| {k} | {m['n_trades']} | {_f(m['expectancy_bps'])} [{_f(ci[0])}, {_f(ci[1])}] | {_f(m['gross_bps'])} | "
                     f"{_f(m['hit_rate'])} | {_f(m['total_bps'],0)} | {_f(m['max_dd_bps'],0)} | {_f(m['turnover_per_day'],2)} |")
        rm = res["random_matched"]
        L.append(f"\nRandom entries (matched count, {rm['draws']} draws): mean expectancy {_f(rm['expectancy_bps_mean'])} bps, "
                 f"95th pct {_f(rm['expectancy_bps_p95'])}; exhaustion beats {_f(100*rm['exhaustion_percentile_vs_random'],0)}% of draws.")
        L.append("\nPer volatility regime (terciles fixed from first train block):\n")
        L.append("| regime | trades | expectancy bps | hit |\n|---|---|---|---|")
        for k, m in res["exhaustion_by_regime"].items():
            L.append(f"| {k} | {m['n_trades']} | {_f(m['expectancy_bps'])} | {_f(m['hit_rate'])} |")
        if "deflated_sharpe_prob" in res:
            L.append(f"\nDeflated Sharpe probability (trials = exit variants × strategies compared): **{_f(res['deflated_sharpe_prob'],3)}**. "
                     "Every additional parameter set tried must be added to the trial count.")
    L.append("\n## Caveats\n\n- Costs: spread, taker fees both sides, square-root slippage, adverse-selection haircut, funding accrual, "
             "gap-through stop fills. Queue position, partial fills and latency are not modeled.\n"
             "- Detector thresholds are fixed defaults, not tuned on this data; tuning must happen inside train folds only.\n"
             "- Survivorship: BTC/ETH perps only; delisted contracts and venue outages are not represented.")
    return "\n".join(L) + "\n"


def write_report(r: dict, out_dir: str | Path, stem: str) -> tuple[Path, Path]:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    md, js = out / f"{stem}.md", out / f"{stem}.json"
    md.write_text(render_markdown(r))
    js.write_text(json.dumps(r, indent=2, default=lambda o: None if isinstance(o, float) and not np.isfinite(o) else str(o)))
    return md, js

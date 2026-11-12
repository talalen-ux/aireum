import numpy as np
import pandas as pd
import pytest

from atlas_research import backtest as bt
from atlas_research.data import build_frame, load_agg_trades, synthetic_frame, trades_to_bars
from atlas_research.exhaustion import detect
from atlas_research.features import compute_features, robust_z


@pytest.fixture(scope="module")
def market():
    return synthetic_frame(n=8000, seed=3, n_episodes=20)


def test_robust_z_is_past_only():
    rng = np.random.default_rng(0)
    x = rng.normal(size=500)
    z1 = robust_z(x, 100, 30)
    y = x.copy()
    y[300:] = rng.normal(50, 10, 200)  # perturb the future
    z2 = robust_z(y, 100, 30)
    np.testing.assert_array_equal(z1[:300], z2[:300])


def test_features_have_no_look_ahead(market):
    f = market.frame
    cut = 5000
    a = compute_features(f)
    g = f.copy()
    rng = np.random.default_rng(1)
    g.iloc[cut:, g.columns.get_loc("close")] *= np.exp(rng.normal(0, 0.01, len(g) - cut))
    g.iloc[cut:, g.columns.get_loc("perp_signed")] = rng.normal(0, 500, len(g) - cut)
    g.iloc[cut:, g.columns.get_loc("spot_signed")] = rng.normal(0, 500, len(g) - cut)
    g.iloc[cut:, g.columns.get_loc("oi")] *= 3
    b = compute_features(g)
    pd.testing.assert_frame_equal(a.iloc[:cut], b.iloc[:cut])


def test_detector_events_are_point_in_time(market):
    f = market.frame
    feat = compute_features(f)
    full = detect(f, feat)
    cut = 6000
    part = detect(f.iloc[:cut], compute_features(f.iloc[:cut]))
    assert [(e.i, e.side) for e in full if e.i < cut] == [(e.i, e.side) for e in part]


def test_splits_do_not_overlap_and_respect_purge():
    for mode in ("expanding", "rolling"):
        splits = bt.walk_forward_splits(10_000, n_splits=5, purge=48, embargo=24, mode=mode)
        tests = [set(s.test.tolist()) for s in splits]
        for i in range(len(tests)):
            for j in range(i + 1, len(tests)):
                assert not tests[i] & tests[j]
        for s in splits:
            assert s.train.max() + 48 + 24 <= s.test.min()
            assert not set(s.train.tolist()) & set(s.test.tolist())


def test_costs_reduce_expectancy(market):
    f = market.frame
    feat = compute_features(f)
    sig = bt.baseline_mean_reversion(feat)
    atr = feat["atr"].to_numpy()
    rule = bt.ExitRule(horizon=24)
    gross = bt.run_trades(f, sig, rule, bt.Costs.zero(), atr)
    net = bt.run_trades(f, sig, rule, bt.Costs(), atr)
    assert len(gross) == len(net) > 10
    assert np.mean([t.net_bps for t in net]) < np.mean([t.net_bps for t in gross])
    assert all(t.cost_bps > 2 * (bt.Costs().half_spread_bps + bt.Costs().taker_fee_bps) - 1 for t in net)
    bigger = bt.run_trades(f, sig, rule, bt.Costs(notional_usd=50_000_000), atr)
    assert np.mean([t.cost_bps for t in bigger]) > np.mean([t.cost_bps for t in net])


def test_entries_execute_on_next_bar_open(market):
    f = market.frame
    sig = np.zeros(len(f), dtype=int)
    sig[1000] = 1
    atr = compute_features(f)["atr"].to_numpy()
    t = bt.run_trades(f, sig, bt.ExitRule(horizon=10), bt.Costs.zero(), atr)[0]
    assert t.i_entry == 1001 and t.entry == f["open"].iloc[1001]


def test_detector_fires_on_planted_episodes_more_than_elsewhere():
    rates_in, rates_out = [], []
    for seed in (3, 5, 9):
        m = synthetic_frame(n=12_000, seed=seed, n_episodes=30)
        ev = detect(m.frame, compute_features(m.frame))
        win = np.zeros(len(m.frame), dtype=bool)
        for ep in m.episodes:
            if ep.kind.endswith("exhaustion"):
                win[ep.exhaustion:ep.reversal + 6] = True
        hits = np.zeros(len(m.frame), dtype=bool)
        for e in ev:
            hits[e.i] = True
        rates_in.append(hits[win].mean())
        rates_out.append(hits[~win].mean())
    # Events per bar inside planted exhaustion windows must clearly exceed the background rate
    # (a random/uninformed detector would have ratio ~1).
    assert np.mean(rates_in) > 5 * np.mean(rates_out)


def test_decoys_rarely_trigger():
    m = synthetic_frame(n=12_000, seed=5, n_episodes=30, decoy_ratio=0.5)
    ev = detect(m.frame, compute_features(m.frame))
    decoys = [ep for ep in m.episodes if ep.kind.endswith("decoy")]
    exh = [ep for ep in m.episodes if ep.kind.endswith("exhaustion")]
    side = lambda k: "long" if k.startswith("down") else "short"
    fa = sum(any(e.side == side(ep.kind) and ep.exhaustion <= e.i <= ep.reversal + 6 for e in ev) for ep in decoys)
    tp = sum(any(e.side == side(ep.kind) and ep.exhaustion <= e.i <= ep.reversal + 6 for e in ev) for ep in exh)
    assert tp / len(exh) > fa / max(len(decoys), 1)


def test_deflated_sharpe_penalizes_trials():
    assert bt.deflated_sharpe(0.1, 500, 1) > bt.deflated_sharpe(0.1, 500, 100)


def test_agg_trades_loader_both_formats(tmp_path):
    rows = [(1, 100.0, 1.0, 1, 1, 1700000000000, "false", "true"),
            (2, 101.0, 2.0, 2, 2, 1700000001000, "true", "true"),
            (2, 101.0, 2.0, 2, 2, 1700000001000, "true", "true")]  # duplicate id
    p1 = tmp_path / "spot.csv"
    p1.write_text("\n".join(",".join(map(str, r)) for r in rows))
    p2 = tmp_path / "perp.csv"
    p2.write_text("agg_trade_id,price,quantity,first_trade_id,last_trade_id,transact_time,is_buyer_maker\n"
                  + "\n".join(",".join(map(str, r[:7])) for r in rows))
    for p in (p1, p2):
        t = load_agg_trades(p)
        assert len(t) == 2 and list(t["side"]) == [1, -1]
        bars = trades_to_bars(t, "1min")
        assert bars["signed"].sum() == pytest.approx(-1.0)
    f = build_frame(trades_to_bars(load_agg_trades(p2), "1min"), freq="1min")
    assert np.isnan(f["oi"]).all()  # missing source stays missing, never imputed

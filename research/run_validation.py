#!/usr/bin/env python3
"""Walk-forward validation CLI.

  python research/run_validation.py --synthetic
  python research/run_validation.py --data-dir data/BTCUSDT --symbol BTCUSDT
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from atlas_research import backtest as bt  # noqa: E402
from atlas_research.data import load_binance_dir, synthetic_frame  # noqa: E402
from atlas_research.report import run_validation, write_report  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--synthetic", action="store_true", help="planted-episode synthetic market (tests the harness only)")
    src.add_argument("--data-dir", type=Path, help="directory of extracted Binance public-data CSVs (see README)")
    ap.add_argument("--symbol", default="BTCUSDT")
    ap.add_argument("--freq", default="5min")
    ap.add_argument("--bars", type=int, default=20_000, help="synthetic bar count")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--splits", type=int, default=5)
    ap.add_argument("--notional", type=float, default=250_000.0)
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent / "reports")
    a = ap.parse_args()

    episodes = None
    if a.synthetic:
        m = synthetic_frame(n=a.bars, seed=a.seed)
        frame, episodes, stem = m.frame, m.episodes, f"synthetic_seed{a.seed}"
    else:
        frame, stem = load_binance_dir(a.data_dir, a.symbol, a.freq), f"{a.symbol}_{a.freq}"
    r = run_validation(frame, episodes, costs=bt.Costs(notional_usd=a.notional), n_splits=a.splits)
    md, js = write_report(r, a.out, stem)
    print(md.read_text())
    print(f"wrote {md}\nwrote {js}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

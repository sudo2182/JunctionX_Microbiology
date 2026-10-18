"""Run the anomaly engine over the synthetic CSVs.

    python -m pipeline.anomaly --data ../data/tyks --from 56 --to 156 --out alerts.json

Prints a per-week summary and writes the episodes with their firings as JSON, in the
shape ``python -m pipeline.feeds --json`` reads. The database job
(pipeline/detect.py in BUILD_PLAN §2) calls ``Engine.detect_week`` the same way, with
frames read from ``lab.*`` instead of CSVs.
"""

from __future__ import annotations

import argparse
import json
from collections import Counter

from .data import load_csv_dir, week_label
from .engine import Engine
from .episodes import build_episodes


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True, help="folder with cultures.csv, isolates.csv, susceptibility.csv")
    ap.add_argument("--from", dest="first", type=int, default=56, help="first week_idx (default 56)")
    ap.add_argument("--to", dest="last", type=int, default=None, help="last week_idx (default: last in data)")
    ap.add_argument("--out", help="write episodes and their firings to this JSON file")
    ap.add_argument("--top", type=int, default=3, help="alerts to print per week")
    args = ap.parse_args(argv)

    engine = Engine(*load_csv_dir(args.data))
    last = args.last or engine.last_week
    alerts = []
    for t in range(args.first, last + 1):
        week = engine.detect_week(t)
        alerts += week
        bands = Counter(a.severity for a in week)
        print(f"{week_label(t)}  " + " ".join(f"{k}={bands[k]}" for k in ("critical", "high", "medium", "low")))
        for a in week[: args.top]:
            print(f"    [{a.severity}/{a.confidence} {a.rank}] {a.sentence}")
    episodes = build_episodes(alerts, last)
    print(f"\n{len(alerts)} alerts in {len(episodes)} episodes")
    if args.out:
        with open(args.out, "w") as f:
            json.dump(
                {"cursor_week_idx": last, "episodes": [e.to_feed_dict() for e in episodes]}, f, indent=1, default=float
            )


if __name__ == "__main__":
    main()

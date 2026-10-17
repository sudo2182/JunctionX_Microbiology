"""Anomaly engine -> agg.alert_episodes / agg.alert_firings (BUILD_PLAN.md §7).

Placeholder: owned by the anomaly-engine build. Contract with pipeline.run:

    run(conn, weeks: list[int], run_id: str, ref) -> dict

is called once per replay run with every week_idx just released (in order) and must be idempotent
for a given week. Read agg.rates (already computed for those weeks) and lab.* for counts; thresholds
live in ref.alert_rules; statistics helpers are in pipeline.stats.
"""

from __future__ import annotations


def run(conn, weeks: list[int], run_id: str, ref=None) -> dict:
    return {"status": "not_implemented", "weeks": len(weeks)}

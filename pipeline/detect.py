"""Anomaly detection step -> agg.alert_episodes / agg.alert_firings (BUILD_PLAN.md §7).

Contract with pipeline.run:

    run(conn, weeks: list[int], run_id: str, ref=None) -> dict

The engine itself lives in pipeline.anomaly and is pure pandas. This module only moves data in and out of
Postgres: it reads the released lab data, runs the engine for every week from MIN_BASELINE_WEEK to the
cursor, and rewrites the alerts. Recomputing from scratch on every run keeps the step deterministic and safe
to repeat (about 1 s per week); the only state kept from the previous run is an analyst's acknowledge or
dismiss on an episode.
"""

from __future__ import annotations

import json
import logging

import pandas as pd

from pipeline import db
from pipeline.anomaly import Engine, build_episodes
from pipeline.anomaly.config import PHENOTYPES
from pipeline.anomaly.data import ISOLATE_COLUMNS, MARKER_COLUMNS
from pipeline.replay import MIN_BASELINE_WEEK, get_cursor

log = logging.getLogger(__name__)

USER_STATUSES = ("acknowledged", "dismissed")


def engine_frames(isolates: pd.DataFrame, ast: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Turn the released lab frames (pipeline.db.load_lab_frames) into the engine's input contract.

    Intrinsic-resistance pairs and urine-only agents on other specimens are dropped through the flags
    set by clean.py (R1, R2), so the engine sees the same reportable results as agg.rates.
    """
    iso = isolates.copy()
    iso["sample_date"] = pd.to_datetime(iso["sample_date"])
    reportable = ast[~ast["is_intrinsic"].astype(bool) & ast["reportable"].astype(bool)]
    # Only S and R reach lab.susceptibility (anything else is rejected during cleaning), so
    # "not R" is "S" here and no unknown result is ever turned into a susceptible one.
    agents = pd.DataFrame(
        {
            "isolate_id": reportable["isolate_id"],
            "marker": reportable["antibiotic_code"],
            "resistant": reportable["result"].eq("R"),
        }
    )
    phenotypes = pd.concat(
        [
            pd.DataFrame({"isolate_id": iso["isolate_id"], "marker": p, "resistant": iso[p.lower()].astype(bool)})
            for p in PHENOTYPES
        ],
        ignore_index=True,
    )
    markers = pd.concat([agents, phenotypes], ignore_index=True)[MARKER_COLUMNS]
    return iso[ISOLATE_COLUMNS].reset_index(drop=True), markers.reset_index(drop=True)


def _episode_row(ep) -> dict:
    d = ep.to_dict()
    return {
        "episode_id": d["episode_id"],
        "key": d["key"],
        "signal_type": d["type"],
        "organism": d["organism"],
        "antibiotic_code": d["marker"],
        "specimen": d["specimen"],
        "scope_type": d["scope_type"],
        "scope_value": d["scope_value"],
        "opened_week": d["opened_week"],
        "last_fired_week": d["last_fired_week"],
        "status": d["status"],
        "severity": d["severity"],
        "severity_points": d["severity_points"],
        "confidence": d["confidence"],
        "rank": d["rank"],
        "explanation": d["headline"],
    }


def write_episodes(conn, episodes) -> None:
    """Replace the stored alerts with `episodes`, keeping an analyst's acknowledge / dismiss."""
    with conn.cursor() as cur:
        cur.execute(
            "select episode_id, status, status_note from agg.alert_episodes where status = any(%s)",
            (list(USER_STATUSES),),
        )
        kept = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
        cur.execute("delete from agg.alert_firings")
        cur.execute("delete from agg.alert_episodes")
        for ep in episodes:
            row = _episode_row(ep)
            if row["episode_id"] in kept:
                row["status"], row["status_note"] = kept[row["episode_id"]]
            else:
                row["status_note"] = None
            cols = list(row)
            cur.execute(
                f"insert into agg.alert_episodes ({', '.join(cols)}) values ({', '.join(['%s'] * len(cols))})",
                [row[c] for c in cols],
            )
            cur.executemany(
                "insert into agg.alert_firings (episode_id, week_idx, evidence) values (%s, %s, %s)",
                [(row["episode_id"], a.week_idx, json.dumps(a.to_dict(), default=float)) for a in ep.firings],
            )
    conn.commit()


def run(conn, weeks: list[int], run_id: str, ref=None) -> dict:
    cursor = get_cursor(conn)
    if cursor < MIN_BASELINE_WEEK:
        reason = f"needs a 52-week baseline; cursor is {cursor}, first week is {MIN_BASELINE_WEEK}"
        return {"status": "skipped", "reason": reason}
    isolates, ast = db.load_lab_frames(conn, 1, cursor)
    engine = Engine(*engine_frames(isolates, ast))
    alerts = engine.detect_range(MIN_BASELINE_WEEK, cursor)
    episodes = build_episodes(alerts, cursor)
    write_episodes(conn, episodes)
    open_now = sum(e.status != "resolved" for e in episodes)
    log.info("detect: %d alerts, %d episodes (%d not resolved)", len(alerts), len(episodes), open_now)
    return {"status": "ok", "through_week": cursor, "alerts": len(alerts), "episodes": len(episodes),
            "not_resolved": open_now, "released_weeks": len(weeks)}


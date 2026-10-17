"""Weekly replay: release the next ISO week(s) from staging.* into lab.* (BUILD_PLAN.md §3.1).

    python -m pipeline.replay --advance 1
    python -m pipeline.replay --reset-to 85

`advance` copies cultures with week_idx in (cursor, cursor + N] plus their isolates and AST rows,
cleaned by clean.py, inside one transaction, then moves the cursor. Re-running a step inserts nothing
new (on conflict do nothing). Most callers should use `python -m pipeline.run`, which also
aggregates, detects and publishes the feed for each released week.
"""

from __future__ import annotations

import argparse
import logging

import pandas as pd

from pipeline import config, db
from pipeline.clean import (
    LAB_AST_COLUMNS,
    LAB_CULTURE_COLUMNS,
    LAB_ISOLATE_COLUMNS,
    RawBatch,
    clean_batch,
    validate,
)
from pipeline.reference import Reference
from pipeline.weeks import LAST_WEEK_IDX

log = logging.getLogger(__name__)

# Below this the 52-week baseline (weeks t-55..t-4) is incomplete (§3.1).
MIN_BASELINE_WEEK = 56


class ValidationFailed(RuntimeError):
    def __init__(self, failures: list[dict]):
        super().__init__("; ".join(f"week {f['week_idx']}: {f['check_name']} ({f['detail'] or f['value']})"
                                   for f in failures))
        self.failures = failures


def get_cursor(conn) -> int:
    with conn.cursor() as cur:
        cur.execute("select cursor_week_idx from lab.replay_state where id = 1")
        return int(cur.fetchone()[0])


def load_staging_batch(conn, after_week: int, through_week: int) -> RawBatch:
    params = (after_week, through_week)
    cultures = db.read_df(conn, "select * from staging.cultures where week_idx > %s and week_idx <= %s", params)
    isolates = db.read_df(
        conn,
        "select i.* from staging.isolates i join staging.cultures c using (culture_id) "
        "where c.week_idx > %s and c.week_idx <= %s",
        params,
    )
    ast = db.read_df(
        conn,
        "select s.* from staging.susceptibility s join staging.cultures c using (culture_id) "
        "where c.week_idx > %s and c.week_idx <= %s",
        params,
    )
    patients = db.read_df(
        conn,
        "select distinct p.patient_id, p.sex from staging.patients p join staging.cultures c using (patient_id) "
        "where c.week_idx > %s and c.week_idx <= %s",
        params,
    )
    return RawBatch(cultures=cultures, isolates=isolates, susceptibility=ast, patients=patients)


def advance(conn, weeks: int, run_id: str, ref: Reference | None = None) -> list[int]:
    """Release the next `weeks` ISO weeks. Returns the week_idx values released (may be empty)."""
    cursor = get_cursor(conn)
    target = min(cursor + weeks, LAST_WEEK_IDX)
    if target <= cursor:
        log.info("cursor already at week %d: end of dataset, nothing to release", cursor)
        return []
    released = list(range(cursor + 1, target + 1))

    raw = load_staging_batch(conn, cursor, target)
    batch = clean_batch(raw, ref)
    history = db.read_df(conn, "select week_idx, count(*) as n from lab.cultures group by week_idx")
    history_series = (pd.Series(history["n"].astype(int).values, index=history["week_idx"].astype(int))
                      if len(history) else None)
    checks = validate(batch, released, history_series)
    dq = pd.DataFrame(batch.dq + checks).assign(run_id=run_id)
    failures = [c for c in checks if c["status"] == "fail"]

    if failures:
        conn.rollback()
        db.write_dq(conn, dq)
        conn.commit()
        raise ValidationFailed(failures)

    db.upsert_df(conn, "lab.cultures", batch.cultures, LAB_CULTURE_COLUMNS)
    db.upsert_df(conn, "lab.isolates", batch.isolates, LAB_ISOLATE_COLUMNS)
    db.upsert_df(conn, "lab.susceptibility", batch.susceptibility, LAB_AST_COLUMNS)
    if len(batch.rejects):
        db.upsert_df(conn, "lab.rejects", batch.rejects.assign(run_id=run_id),
                     ["run_id", "week_idx", "table_name", "row_key", "reason"])
    db.write_dq(conn, dq)
    with conn.cursor() as cur:
        cur.execute(
            "update lab.replay_state set cursor_week_idx = %s, updated_at = now(), run_id = %s where id = 1",
            (target, run_id),
        )
    conn.commit()
    log.info("released weeks %d..%d: %d cultures, %d isolates, %d AST rows, %d rejects",
             released[0], released[-1], len(batch.cultures), len(batch.isolates),
             len(batch.susceptibility), len(batch.rejects))
    return released


def reset(conn) -> None:
    """Empty lab.* results, aggregates and alerts and set the cursor to 0. Run log and dq_log are kept."""
    with conn.cursor() as cur:
        cur.execute(
            "truncate lab.susceptibility, lab.isolates, lab.cultures, lab.rejects, "
            "agg.rates, agg.rates_demo, agg.feed_log, agg.alert_firings, agg.alert_episodes"
        )
        cur.execute("update lab.replay_state set cursor_week_idx = 0, updated_at = now() where id = 1")
    conn.commit()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--advance", type=int, default=1)
    ap.add_argument("--reset-to", type=int, default=None)
    args = ap.parse_args()
    from pipeline.run import new_run_id

    run_id = new_run_id()
    with db.connect(config.db_url()) as conn:
        ref = db.load_reference(conn)
        if args.reset_to is not None:
            reset(conn)
            print(advance(conn, args.reset_to, run_id, ref))
        else:
            print(advance(conn, args.advance, run_id, ref))


if __name__ == "__main__":
    main()

"""One replay run: advance cursor -> clean -> aggregate -> detect -> publish feed -> log (§2, §5.2).

    python -m pipeline.run --advance 1
    python -m pipeline.run --reset-to 85          # demo start: 2025-W20
    python -m pipeline.run --seed --reset-to 85   # first time: load staging.* from the CSVs too

Every released week is aggregated and passed to detection, so a reset backfills a complete history.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import time
import uuid
from datetime import UTC, datetime

from pipeline import aggregate, config, db, detect, replay, seed
from pipeline.weeks import week_label

log = logging.getLogger("pipeline.run")


def new_run_id() -> str:
    gh = os.environ.get("GITHUB_RUN_ID")
    attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "1")
    if gh:
        return f"gh-{gh}-{attempt}"
    return datetime.now(UTC).strftime("local-%Y%m%dT%H%M%S-") + uuid.uuid4().hex[:6]


def _optional_int(value: str | None) -> int | None:
    return int(value) if value not in (None, "") else None


def publish_feeds(conn, upload: bool) -> dict:
    """Last step: RSS feeds (pipeline/feeds, BUILD_PLAN.md §8). Skipped until that package is merged."""
    try:
        from pipeline.feeds.publish import run as publish
    except ImportError:
        return {"status": "skipped", "reason": "pipeline.feeds not installed yet"}
    files = publish(conn=conn, upload=upload)
    conn.commit()
    return {"status": "published" if upload else "rendered", "feeds": len(files or {})}


def execute(
    conn, advance: int, reset_to: int | None, do_seed: bool, run_id: str, upload: bool = False
) -> dict:
    steps: dict = {}

    def step(name, fn):
        t = time.monotonic()
        steps[name] = fn() or {}
        steps[name]["seconds"] = round(time.monotonic() - t, 2)
        log.info("%s: %s", name, steps[name])

    cursor_from = replay.get_cursor(conn)
    with conn.cursor() as cur:
        cur.execute(
            "insert into lab.pipeline_runs (run_id, cursor_from, run_url) values (%s, %s, %s) "
            "on conflict (run_id) do update set started_at = now(), status = 'running', error = null",
            (run_id, cursor_from, config.run_url()),
        )
    conn.commit()

    try:
        if do_seed:
            step("seed", lambda: seed.seed(conn, config.data_dir()))
        ref = db.load_reference(conn)
        released: list[int] = []

        def do_advance(n: int) -> dict:
            released.extend(replay.advance(conn, n, run_id, ref))
            return {"weeks_released": len(released)}

        if reset_to is not None:
            if reset_to < replay.MIN_BASELINE_WEEK:
                log.warning("reset_to=%d is before week %d: the 52-week baseline will be incomplete",
                            reset_to, replay.MIN_BASELINE_WEEK)
            step("reset", lambda: replay.reset(conn))
            step("advance", lambda: do_advance(reset_to))
        else:
            step("advance", lambda: do_advance(advance))
        step("aggregate", lambda: aggregate.run(conn, released, run_id, ref))
        step("detect", lambda: detect.run(conn, released, run_id, ref))
        step("feed", lambda: publish_feeds(conn, upload))
        status, error = "success", None
    except Exception as exc:  # recorded in lab.pipeline_runs, then re-raised so the Action fails
        conn.rollback()
        status, error = "failed", str(exc)
        raise
    finally:
        cursor_to = replay.get_cursor(conn)
        with conn.cursor() as cur:
            cur.execute(
                "update lab.pipeline_runs set finished_at = now(), status = %s, cursor_to = %s, "
                "steps = %s, error = %s where run_id = %s",
                (status, cursor_to, json.dumps(steps, default=str), error, run_id),
            )
        conn.commit()
        if cursor_to:
            log.info("data through %s (week_idx %d), run %s: %s", week_label(cursor_to), cursor_to, run_id, status)
    return steps


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--advance", type=_optional_int, default=1, help="weeks to release (default 1)")
    ap.add_argument("--reset-to", type=_optional_int, default=None,
                    help="empty lab/agg and backfill weeks 1..N (blank = no reset)")
    ap.add_argument("--seed", action="store_true", help="(re)load staging.* from the CSVs first")
    ap.add_argument("--no-upload", action="store_true",
                    help="render feeds but do not upload them to Supabase Storage")
    args = ap.parse_args()
    upload = not args.no_upload and bool(os.environ.get("SUPABASE_SERVICE_ROLE_KEY"))
    with db.connect(config.db_url()) as conn:
        execute(conn, args.advance or 1, args.reset_to, args.seed, new_run_id(), upload)


if __name__ == "__main__":
    main()

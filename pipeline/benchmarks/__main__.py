"""Import external surveillance data into bench.observations.

    python -m pipeline.benchmarks --source thl_nidr [--from-year 2015] [--dry-run]
    python -m pipeline.benchmarks --source finres [--release 2024]
    python -m pipeline.benchmarks --source all

Needs SUPABASE_DB_URL (except with --dry-run, which then only parses and validates).
"""

from __future__ import annotations

import argparse
import logging
import os

from pipeline import config, db
from pipeline.benchmarks import finres, store, thl_nidr
from pipeline.benchmarks.model import ValidationError, validate

log = logging.getLogger("pipeline.benchmarks")


def _batches(args) -> list[tuple[str, str, callable]]:
    jobs = []
    if args.source in ("thl_nidr", "all"):
        jobs.append((thl_nidr.SOURCE_ID, thl_nidr.DATASET, lambda: thl_nidr.load(args.from_year)))
    if args.source in ("finres", "all"):
        jobs.append((finres.SOURCE_ID, finres.DATASET, lambda: finres.load(args.release)))
    return jobs


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", choices=["thl_nidr", "finres", "all"])
    ap.add_argument("--dry-run", action="store_true", help="parse, validate and diff; write nothing")
    ap.add_argument("--from-year", type=int, default=2015, help="thl_nidr: first year to import")
    ap.add_argument("--release", default="2024", help="finres: report edition")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    if not args.source:
        ap.error("--source is required")

    offline = args.dry_run and not os.environ.get("SUPABASE_DB_URL")
    conn = None if offline else db.connect(config.db_url())
    summaries, failed = [], False
    try:
        if conn is not None and not args.dry_run:
            log.info("comparability rows synced: %d", store.sync_comparability(conn))
        for source_id, dataset, job in _batches(args):
            try:
                batch = job()
                if conn is None:
                    validate(batch.rows, where=f"{source_id}/{dataset}")
                    summaries.append(f"{source_id}/{dataset} (offline dry run): {len(batch.rows)} rows valid, "
                                     f"{batch.skipped} skipped")
                else:
                    summaries.append(store.import_batch(conn, batch, dry_run=args.dry_run).summary())
            except Exception as exc:  # noqa: BLE001  keep going with the other sources, then exit non-zero
                failed = True
                log.error("%s/%s failed: %s", source_id, dataset, exc)
                summaries.append(f"{source_id}/{dataset}: FAILED: {exc}")
                if conn is not None and not args.dry_run and not isinstance(exc, ValidationError):
                    store.record_failure(conn, source_id, dataset, str(exc))
    finally:
        if conn is not None:
            conn.close()
    md = "## External benchmarks import\n\n" + "\n".join(f"- {s}" for s in summaries) + "\n"
    print(md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
            fh.write(md)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

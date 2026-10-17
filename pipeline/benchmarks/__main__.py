"""Import external surveillance data into bench.observations.

    python -m pipeline.benchmarks --source thl_nidr [--from-year 2015] [--dry-run]
    python -m pipeline.benchmarks --source finres [--release 2024]
    python -m pipeline.benchmarks --source ecdc --file pipeline/benchmarks/raw/ecdc_atlas_2026-10-18.csv
    python -m pipeline.benchmarks --source ecdc --storage-path benchmark-raw/ecdc_atlas_2026-10-18.csv
    python -m pipeline.benchmarks --source ecdc --file F --register --retrieved-on 2026-10-18 --note "FI, all years"
    python -m pipeline.benchmarks --inspect-ecdc FILE
    python -m pipeline.benchmarks --source all

Needs SUPABASE_DB_URL (except with --dry-run, which then only parses and validates).
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from pipeline import config, db
from pipeline.benchmarks import ecdc_atlas, finres, raw_store, store, thl_nidr
from pipeline.benchmarks.model import ValidationError, validate

log = logging.getLogger("pipeline.benchmarks")


def _ecdc_batch(args) -> store.Batch:
    if args.file:
        path = Path(args.file)
        data, name = path.read_bytes(), path.name
        if args.register:
            if not (args.retrieved_on and args.note):
                sys.exit("--register needs --retrieved-on YYYY-MM-DD and --note describing the export settings")
            ecdc_atlas.parse(data, name, args.retrieved_on)     # a file that does not parse is never registered
            entry = ecdc_atlas.register(name, data, args.retrieved_on, args.note, args.storage_path)
            print(f"registered {name} (sha256 {entry['sha256']}); commit pipeline/benchmarks/manifest/ecdc_atlas.json")
    elif args.storage_path:
        data, name = raw_store.download(args.storage_path), args.storage_path.rsplit("/", 1)[-1]
    else:
        sys.exit("--source ecdc needs --file PATH or --storage-path BUCKET/FILE")
    return ecdc_atlas.load(data, name)


def _batches(args) -> list[tuple[str, str, callable]]:
    jobs = []
    if args.source in ("thl_nidr", "all"):
        jobs.append((thl_nidr.SOURCE_ID, thl_nidr.DATASET, lambda: thl_nidr.load(args.from_year)))
    if args.source in ("finres", "all"):
        jobs.append((finres.SOURCE_ID, finres.DATASET, lambda: finres.load(args.release)))
    if args.source == "ecdc":
        jobs.append((ecdc_atlas.SOURCE_ID, ecdc_atlas.DATASET, lambda: _ecdc_batch(args)))
    elif args.source == "all" and os.environ.get("SUPABASE_URL") and os.environ.get("SUPABASE_SERVICE_ROLE_KEY"):
        for entry in ecdc_atlas.read_manifest()["files"]:
            def job(e=entry):
                return ecdc_atlas.load(raw_store.download(e["storage_path"]), e["name"])
            jobs.append((ecdc_atlas.SOURCE_ID, ecdc_atlas.DATASET, job))
    return jobs


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--source", choices=["thl_nidr", "finres", "ecdc", "all"])
    ap.add_argument("--dry-run", action="store_true", help="parse, validate and diff; write nothing")
    ap.add_argument("--from-year", type=int, default=2015, help="thl_nidr: first year to import")
    ap.add_argument("--release", default="2024", help="finres: report edition")
    ap.add_argument("--file", help="ecdc: local Atlas CSV export")
    ap.add_argument("--storage-path", help="ecdc: '<bucket>/<file>' in Supabase Storage")
    ap.add_argument("--register", action="store_true", help="ecdc: add --file to the checksum manifest first")
    ap.add_argument("--retrieved-on", help="ecdc --register: date of the export, YYYY-MM-DD")
    ap.add_argument("--note", help="ecdc --register: the export settings used")
    ap.add_argument("--inspect-ecdc", metavar="FILE", help="print the headers and sample labels of an Atlas CSV")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    if args.inspect_ecdc:
        print(ecdc_atlas.inspect(Path(args.inspect_ecdc).read_bytes()))
        return 0
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

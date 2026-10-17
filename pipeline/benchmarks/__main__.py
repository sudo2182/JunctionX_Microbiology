"""python -m pipeline.benchmarks  (see --help)."""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from pipeline.benchmarks.refresh import PARSERS, RAW_DIR, run


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Refresh bench.rates from ECDC, THL and WHO GLASS exports.")
    ap.add_argument("--sources", default=",".join(PARSERS), help="comma-separated: ecdc,thl,glass")
    ap.add_argument("--raw-dir", type=Path, default=RAW_DIR)
    ap.add_argument("--dry-run", action="store_true", help="parse, validate and diff, but write nothing")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    sources = [s.strip() for s in args.sources.split(",") if s.strip()]
    unknown = set(sources) - set(PARSERS)
    if unknown:
        ap.error(f"unknown sources: {', '.join(sorted(unknown))}")

    db_url = os.environ.get("SUPABASE_DB_URL")
    if not db_url:
        logging.getLogger(__name__).warning("SUPABASE_DB_URL not set: parsing and validating only")
        run(sources=sources, raw_dir=args.raw_dir, dry_run=True)
        return 0
    import psycopg

    with psycopg.connect(db_url) as conn:
        run(sources=sources, conn=conn, raw_dir=args.raw_dir, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())

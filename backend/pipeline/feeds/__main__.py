"""python -m pipeline.feeds  (see --help)."""

from __future__ import annotations

import argparse
import logging
import os
import sys

from pipeline.feeds.publish import run


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Render AMR Watch RSS feeds and optionally upload them.")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--db", action="store_true", help="read alerts from SUPABASE_DB_URL")
    src.add_argument("--json", metavar="PATH", help="read episodes from a JSON file (fixtures, offline)")
    ap.add_argument("--out-dir", help="also write the XML files here")
    ap.add_argument("--upload", action="store_true", help="upload to the Supabase Storage 'feeds' bucket")
    ap.add_argument("--base-url", default=os.environ.get("APP_BASE_URL"), help="dashboard URL for deep links")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")

    if args.db:
        import psycopg

        with psycopg.connect(os.environ["SUPABASE_DB_URL"]) as conn:
            files = run(conn=conn, out_dir=args.out_dir, upload=args.upload, base_url=args.base_url)
    else:
        files = run(json_path=args.json, out_dir=args.out_dir, upload=args.upload, base_url=args.base_url)
    print(f"{len(files)} feeds rendered", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

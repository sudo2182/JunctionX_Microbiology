"""CLI for running the ECDC RSS announcement checker and AMR monitor.

Usage:
    python -m pipeline.announcements --dry-run
    python -m pipeline.announcements --dry-run --only-relevant
    python -m pipeline.announcements --feeds surveillance,publications
    python -m pipeline.announcements --db
"""

from __future__ import annotations

import argparse
import json
import logging
import sys

from pipeline import config
from pipeline.announcements.config import DEFAULT_ECDC_FEEDS, FeedConfig
from pipeline.announcements.runner import run_checker


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Monitor official ECDC RSS feeds for antimicrobial resistance announcements.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Fetch and classify feeds without writing to the database.",
    )
    parser.add_argument(
        "--db",
        action="store_true",
        help="Store results into Supabase bench.announcements using SUPABASE_DB_URL.",
    )
    parser.add_argument(
        "--only-relevant",
        action="store_true",
        help="Only display/store announcements classified as 'relevant' or 'review'.",
    )
    parser.add_argument(
        "--feeds",
        type=str,
        default=None,
        help="Comma-separated feed keys to check (e.g. 'surveillance,publications,threats_cdtr').",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Maximum items to process per feed.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Output the final report as JSON to stdout.",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Enable debug logging.",
    )
    args = parser.parse_args()

    log_level = logging.DEBUG if args.verbose else logging.INFO
    logging.basicConfig(level=log_level, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    # Filter feeds if requested
    if args.feeds:
        wanted = {k.strip().lower() for k in args.feeds.split(",")}
        selected_feeds: list[FeedConfig] = [f for f in DEFAULT_ECDC_FEEDS if f.key.lower() in wanted]
        if not selected_feeds:
            avail = ", ".join(f.key for f in DEFAULT_ECDC_FEEDS)
            sys.exit(f"Error: No matching feeds found for '{args.feeds}'. Available: {avail}")
    else:
        selected_feeds = DEFAULT_ECDC_FEEDS

    conn = None
    dry_run = args.dry_run or not args.db

    if args.db:
        try:
            import psycopg
            conn = psycopg.connect(config.db_url(), autocommit=False, prepare_threshold=None)
            dry_run = False
        except Exception as exc:
            logging.getLogger("pipeline.announcements").error("Could not connect to database: %s", exc)
            sys.exit(1)

    try:
        summary = run_checker(
            feeds=selected_feeds,
            conn=conn,
            dry_run=dry_run,
            store_unrelated=not args.only_relevant,
            limit_per_feed=args.limit,
        )
    finally:
        if conn:
            conn.close()

    if args.json:
        # Print pure JSON output
        print(json.dumps(summary, indent=2, default=str))
    else:
        # Print formatted summary table
        m = summary["metrics"]
        print("\n" + "=" * 65)
        print("          ECDC RSS ANNOUNCEMENT MONITOR SUMMARY")
        print("=" * 65)
        print(f"Status:            {summary['status'].upper()}")
        print(f"Feeds Checked:     {m['feeds_checked']} ({m['feeds_succeeded']} succeeded, {m['feeds_failed']} failed)")
        print(f"Items Fetched:     {m['items_fetched']}")
        print(f"  - AMR Relevant:  {m['relevant_items']}")
        print(f"  - Needs Review:  {m['review_items']}")
        print(f"  - Unrelated:     {m['unrelated_items']}")
        if not dry_run:
            print(f"Database Upsert:   {m['inserted']} new, {m['updated']} updated")
        else:
            print("Database Mode:     DRY RUN (no DB changes)")

        if m["errors"]:
            print("\nErrors encountered:")
            for feed_key, err in m["errors"].items():
                print(f"  - [{feed_key}]: {err}")

        # Highlight relevant items
        relevant_items = [it for it in summary["items"] if it["category"] == "relevant"]
        if relevant_items:
            print("\nRecent Relevant AMR Announcements:")
            for it in relevant_items[:10]:
                terms = ", ".join(it["matched_terms"])
                print(f"  * [{it['feed']}] {it['title']}")
                print(f"    Terms: {terms} | Link: {it['url']}")
        print("=" * 65)


if __name__ == "__main__":
    main()

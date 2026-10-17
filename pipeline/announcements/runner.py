"""Orchestrator for checking external feeds, filtering for AMR, and updating the database."""

from __future__ import annotations

import logging
from typing import Any

from pipeline.announcements import db
from pipeline.announcements.config import FeedConfig, get_default_feeds
from pipeline.announcements.fetcher import FeedFetchError, fetch_feed
from pipeline.announcements.filter import RelevanceCategory, classify_announcement
from pipeline.announcements.parser import AnnouncementItem, parse_feed

log = logging.getLogger("pipeline.announcements")


def run_checker(
    feeds: list[FeedConfig] | None = None,
    conn: Any = None,
    dry_run: bool = False,
    store_unrelated: bool = True,
    limit_per_feed: int | None = None,
) -> dict[str, Any]:
    """Check all configured feeds, classify items for AMR relevance, and upsert to database.

    One failing feed is recorded and skipped; the others are still processed. An item that appears in several
    feeds (same guid) is kept once, from the first feed in priority order. With a connection and not dry_run,
    the run is logged in bench.import_runs whatever happens.
    """
    active_feeds = feeds or get_default_feeds()
    results: list[dict[str, Any]] = []
    items_to_save: list[tuple[AnnouncementItem, str, list[str]]] = []
    seen_guids: set[str] = set()

    metrics = {
        "feeds_checked": 0,
        "feeds_succeeded": 0,
        "feeds_failed": 0,
        "items_fetched": 0,
        "relevant_items": 0,
        "review_items": 0,
        "unrelated_items": 0,
        "new_items": 0,
        "already_stored": 0,       # seen in an earlier run
        "duplicates_in_run": 0,    # same item in more than one feed this run
        "duplicates_skipped": 0,   # already_stored + duplicates_in_run
        "skipped_unrelated": 0,
        "errors": {},
    }

    writing = conn is not None and not dry_run
    run_id = db.open_run(conn) if writing else None
    log.info("Starting ECDC announcement check across %d feeds (dry_run=%s)", len(active_feeds), not writing)

    for feed in active_feeds:
        metrics["feeds_checked"] += 1
        log.info("Checking feed [%s]: %s", feed.key, feed.url)
        try:
            fetch_res = fetch_feed(feed.url)
            parsed_items = parse_feed(fetch_res.content, feed)
            if limit_per_feed and len(parsed_items) > limit_per_feed:
                parsed_items = parsed_items[:limit_per_feed]

            metrics["feeds_succeeded"] += 1
            metrics["items_fetched"] += len(parsed_items)

            feed_relevant = 0
            for item in parsed_items:
                if item.guid in seen_guids:
                    metrics["duplicates_in_run"] += 1
                    continue
                seen_guids.add(item.guid)
                category, matched_terms = classify_announcement(item.title, item.summary, item.categories)

                if category == RelevanceCategory.RELEVANT.value:
                    metrics["relevant_items"] += 1
                    feed_relevant += 1
                elif category == RelevanceCategory.REVIEW.value:
                    metrics["review_items"] += 1
                else:
                    metrics["unrelated_items"] += 1

                items_to_save.append((item, category, matched_terms))
                results.append({
                    "feed": feed.key,
                    "title": item.title,
                    "url": item.article_url,
                    "published_at": item.published_at.isoformat() if item.published_at else None,
                    "category": category,
                    "matched_terms": matched_terms,
                })

            log.info("Feed [%s]: %d items fetched, %d AMR-relevant", feed.key, len(parsed_items), feed_relevant)

        except FeedFetchError as err:
            metrics["feeds_failed"] += 1
            metrics["errors"][feed.key] = err.message
            log.warning("Feed [%s] failed: %s (continuing with remaining feeds)", feed.key, err.message)
        except Exception as exc:
            metrics["feeds_failed"] += 1
            metrics["errors"][feed.key] = str(exc)
            log.error("Unexpected error in feed [%s]: %s", feed.key, exc, exc_info=True)

    status = "success" if metrics["feeds_failed"] == 0 else "partial_success"
    if metrics["feeds_succeeded"] == 0 and metrics["feeds_checked"] > 0:
        status = "failed"
    feed_errors = "; ".join(f"{k}: {v}" for k, v in metrics["errors"].items()) or None

    if writing:
        try:
            db_stats = db.upsert_announcements(
                conn=conn, items=items_to_save, store_unrelated=store_unrelated, import_run_id=run_id,
            )
        except Exception as exc:
            conn.rollback()
            db.close_run(conn, run_id, "failed", metrics, f"database write failed: {exc}")
            raise
        metrics["new_items"] = db_stats["inserted"]
        metrics["already_stored"] = db_stats["already_stored"]
        metrics["skipped_unrelated"] = db_stats["skipped_unrelated"]
    metrics["duplicates_skipped"] = metrics["already_stored"] + metrics["duplicates_in_run"]
    if writing:
        db.close_run(conn, run_id, "failed" if status == "failed" else "succeeded", metrics, feed_errors)

    log.info(
        "Run completed: %d feeds checked (%d failed). Items: %d fetched, %d relevant, %d for review, "
        "%d duplicates skipped. DB: %d new.",
        metrics["feeds_checked"],
        metrics["feeds_failed"],
        metrics["items_fetched"],
        metrics["relevant_items"],
        metrics["review_items"],
        metrics["duplicates_skipped"],
        metrics["new_items"],
    )
    return {"status": status, "run_id": run_id, "metrics": metrics, "items": results}

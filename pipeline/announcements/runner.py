"""Orchestrator for checking external feeds, filtering for AMR, and updating the database."""

from __future__ import annotations

import logging
from typing import Any

from pipeline.announcements.config import FeedConfig, get_default_feeds
from pipeline.announcements.db import upsert_announcements
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

    Recovers gracefully if an individual feed fails while continuing to process the others.
    """
    active_feeds = feeds or get_default_feeds()
    results: list[dict[str, Any]] = []
    items_to_save: list[tuple[AnnouncementItem, str, list[str]]] = []

    metrics = {
        "feeds_checked": 0,
        "feeds_succeeded": 0,
        "feeds_failed": 0,
        "items_fetched": 0,
        "relevant_items": 0,
        "review_items": 0,
        "unrelated_items": 0,
        "inserted": 0,
        "updated": 0,
        "skipped_unrelated": 0,
        "errors": {},
    }

    log.info("Starting ECDC announcement check across %d feeds (dry_run=%s)", len(active_feeds), dry_run)

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

    # Database upsert
    if not dry_run and conn:
        db_stats = upsert_announcements(
            conn=conn,
            items=items_to_save,
            source_id="ecdc",
            store_unrelated=store_unrelated,
        )
        metrics["inserted"] = db_stats["inserted"]
        metrics["updated"] = db_stats["updated"]
        metrics["skipped_unrelated"] = db_stats["skipped_unrelated"]

    status = "success" if metrics["feeds_failed"] == 0 else "partial_success"
    if metrics["feeds_succeeded"] == 0 and metrics["feeds_checked"] > 0:
        status = "failed"

    summary = {
        "status": status,
        "metrics": metrics,
        "items": results,
    }

    log.info(
        "Run completed: %d feeds checked (%d failed). Items: %d fetched, %d relevant, %d for review. "
        "DB: %d new, %d updated.",
        metrics["feeds_checked"],
        metrics["feeds_failed"],
        metrics["items_fetched"],
        metrics["relevant_items"],
        metrics["review_items"],
        metrics["inserted"],
        metrics["updated"],
    )
    return summary

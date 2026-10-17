"""Store announcements in bench.announcements (idempotent upsert) and log every check in bench.import_runs."""

from __future__ import annotations

import json
import logging
from typing import Any

from pipeline import config
from pipeline.announcements.config import DATASET, SOURCE_ID
from pipeline.announcements.filter import RelevanceCategory
from pipeline.announcements.parser import AnnouncementItem

log = logging.getLogger("pipeline.announcements.db")


# Keyed on (source_id, guid). A re-seen item keeps its first_detected_at, status and import_run_id; title, link,
# summary and classification follow the latest feed text and rules.
UPSERT_ANNOUNCEMENT_SQL = """
insert into bench.announcements (
  source_id, feed_key, feed_name, feed_url, guid, title, article_url, published_at, last_checked_at,
  summary, relevance_category, matched_terms, raw_metadata, import_run_id
) values (
  %s, %s, %s, %s, %s, %s, %s, %s, now(), %s, %s, %s::jsonb, %s::jsonb, %s
)
on conflict (source_id, guid) do update set
  last_checked_at = now(),
  title = excluded.title,
  article_url = excluded.article_url,
  summary = coalesce(excluded.summary, bench.announcements.summary),
  published_at = coalesce(excluded.published_at, bench.announcements.published_at),
  relevance_category = excluded.relevance_category,
  matched_terms = excluded.matched_terms,
  raw_metadata = excluded.raw_metadata
returning (xmax = 0) as is_new;
"""


def open_run(conn: Any) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "insert into bench.import_runs (source_id, dataset, source_url, retrieved_at, run_url)"
            " values (%s, %s, %s, now(), %s) returning run_id",
            (SOURCE_ID, DATASET, "https://www.ecdc.europa.eu/en/rss-feeds", config.run_url()),
        )
        run_id = cur.fetchone()[0]
    conn.commit()
    return run_id


def close_run(conn: Any, run_id: int, status: str, metrics: dict[str, Any], error: str | None) -> None:
    """status: 'succeeded' when at least one feed was read, else 'failed'. Failed feeds are listed in error."""
    with conn.cursor() as cur:
        cur.execute(
            "update bench.import_runs set finished_at = now(), status = %s, rows_parsed = %s, rows_inserted = %s,"
            " rows_updated = 0, rows_unchanged = %s, rows_skipped = %s, error = %s where run_id = %s",
            (status, metrics["items_fetched"], metrics["new_items"], metrics["already_stored"],
             metrics["duplicates_in_run"] + metrics["skipped_unrelated"], error[:2000] if error else None, run_id),
        )
    conn.commit()


def upsert_announcements(
    conn: Any,
    items: list[tuple[AnnouncementItem, str, list[str]]],
    source_id: str = SOURCE_ID,
    store_unrelated: bool = True,
    import_run_id: int | None = None,
) -> dict[str, int]:
    """Upsert items into bench.announcements idempotently, in one transaction.

    items is a list of tuples: (item, relevance_category, matched_terms), already unique by guid.
    Returns {'inserted', 'already_stored', 'skipped_unrelated'}.
    """
    stats = {"inserted": 0, "already_stored": 0, "skipped_unrelated": 0}
    if not items:
        return stats

    with conn.cursor() as cur:
        for item, category, matched_terms in items:
            if not store_unrelated and category == RelevanceCategory.UNRELATED.value:
                stats["skipped_unrelated"] += 1
                continue

            cur.execute(
                UPSERT_ANNOUNCEMENT_SQL,
                (
                    source_id,
                    item.feed_key,
                    item.feed_name,
                    item.feed_url,
                    item.guid,
                    item.title,
                    item.article_url,
                    item.published_at,
                    item.summary,
                    category,
                    json.dumps(matched_terms),
                    json.dumps(item.raw_metadata or {}),
                    import_run_id,
                ),
            )
            row = cur.fetchone()
            if row and row[0]:
                stats["inserted"] += 1
            else:
                stats["already_stored"] += 1

    conn.commit()
    return stats

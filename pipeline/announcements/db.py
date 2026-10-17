"""Database operations for storing and deduplicating announcements in PostgreSQL/Supabase."""

from __future__ import annotations

import json
import logging
from typing import Any

from pipeline.announcements.filter import RelevanceCategory
from pipeline.announcements.parser import AnnouncementItem

log = logging.getLogger("pipeline.announcements.db")


UPSERT_ANNOUNCEMENT_SQL = """
insert into bench.announcements (
  source_id,
  feed_key,
  feed_name,
  feed_url,
  guid,
  title,
  article_url,
  published_at,
  last_checked_at,
  summary,
  relevance_category,
  matched_terms,
  raw_metadata
) values (
  %s, %s, %s, %s, %s, %s, %s, %s, now(), %s, %s, %s::jsonb, %s::jsonb
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


def upsert_announcements(
    conn: Any,
    items: list[tuple[AnnouncementItem, str, list[str]]],
    source_id: str = "ecdc",
    store_unrelated: bool = True,
) -> dict[str, int]:
    """Upsert items into bench.announcements idempotently.

    items is a list of tuples: (item, relevance_category, matched_terms).
    Returns metrics: {'inserted': int, 'updated': int, 'skipped_unrelated': int}.
    """
    stats = {"inserted": 0, "updated": 0, "skipped_unrelated": 0}
    if not items:
        return stats

    with conn.cursor() as cur:
        for item, category, matched_terms in items:
            if not store_unrelated and category == RelevanceCategory.UNRELATED.value:
                stats["skipped_unrelated"] += 1
                continue

            matched_json = json.dumps(matched_terms)
            meta_json = json.dumps(item.raw_metadata or {})

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
                    matched_json,
                    meta_json,
                ),
            )
            row = cur.fetchone()
            is_new = row[0] if row else False
            if is_new:
                stats["inserted"] += 1
            else:
                stats["updated"] += 1

    conn.commit()
    return stats

"""Feed parser normalizing RSS 2.0 and Atom feeds into structured AnnouncementItem objects."""

from __future__ import annotations

import calendar
import html
import logging
import re
import urllib.parse
from dataclasses import dataclass, field
from datetime import UTC, datetime

import feedparser

from pipeline.announcements.config import FeedConfig

log = logging.getLogger("pipeline.announcements.parser")

_HTML_TAG_RE = re.compile(r"<[^>]+>")
_WHITESPACE_RE = re.compile(r"\s+")
_TRACKING_PARAMS = {"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "rss"}


@dataclass
class AnnouncementItem:
    feed_key: str
    feed_name: str
    feed_url: str
    guid: str
    title: str
    article_url: str
    published_at: datetime | None
    summary: str
    author: str = ""
    categories: list[str] = field(default_factory=list)
    raw_metadata: dict = field(default_factory=dict)


def clean_html_text(raw_text: str | None) -> str:
    """Strip HTML tags, decode entities, and normalize whitespace."""
    if not raw_text:
        return ""
    stripped = _HTML_TAG_RE.sub(" ", raw_text)
    unescaped = html.unescape(stripped)
    normalized = _WHITESPACE_RE.sub(" ", unescaped).strip()
    return normalized


def canonicalize_url(raw_url: str | None) -> str:
    """Normalize article URLs: strip tracking query params and trim spaces."""
    if not raw_url:
        return ""
    clean_url = raw_url.strip()
    try:
        parsed = urllib.parse.urlsplit(clean_url)
        # Filter out tracking query parameters
        if parsed.query:
            query_pairs = urllib.parse.parse_qsl(parsed.query, keep_blank_values=False)
            filtered_pairs = [(k, v) for k, v in query_pairs if k.lower() not in _TRACKING_PARAMS]
            new_query = urllib.parse.urlencode(filtered_pairs)
        else:
            new_query = ""
        # Rebuild URL without tracking query
        rebuilt = urllib.parse.urlunsplit((
            parsed.scheme.lower(),
            parsed.netloc.lower(),
            parsed.path.rstrip("/") if parsed.path != "/" else "/",
            new_query,
            "",  # strip fragment
        ))
        return rebuilt or clean_url
    except Exception:
        return clean_url


def parse_datetime(entry: dict) -> datetime | None:
    """Extract and normalize publication timestamp into UTC datetime."""
    # feedparser gives a struct_time already converted to UTC. timegm reads it as UTC; mktime would read it as
    # the machine's local time and shift every date by the local offset.
    st = entry.get("published_parsed") or entry.get("updated_parsed")
    if st:
        try:
            return datetime.fromtimestamp(calendar.timegm(st), tz=UTC)
        except Exception:
            pass
    return None


class FeedParseError(ValueError):
    """The response was not a readable RSS/Atom feed (e.g. an HTML error page served with HTTP 200)."""


def parse_feed(content: str, feed_config: FeedConfig) -> list[AnnouncementItem]:
    """Parse RSS 2.0 / Atom XML into a list of AnnouncementItem objects.

    A valid feed with no items returns []. An empty body or a document that is not RSS/Atom raises
    FeedParseError, so the run reports the feed as failed instead of as a quiet day.
    """
    if not content or not content.strip():
        raise FeedParseError(f"{feed_config.key}: empty response")

    parsed = feedparser.parse(content)
    if not parsed.entries and not parsed.get("version"):
        reason = parsed.get("bozo_exception") or "unknown format"
        raise FeedParseError(f"{feed_config.key}: not an RSS/Atom feed ({reason})")
    if parsed.get("bozo"):
        log.warning("Feed %s is not well-formed XML; using the %d entries recovered: %s",
                    feed_config.key, len(parsed.entries), parsed.get("bozo_exception"))

    # Get feed channel title or fallback to config name
    channel_title = clean_html_text(parsed.feed.get("title")) if parsed.feed else ""
    feed_display_name = channel_title or feed_config.name

    items: list[AnnouncementItem] = []
    for entry in parsed.entries:
        title = clean_html_text(entry.get("title", ""))
        raw_link = entry.get("link", "")
        article_url = canonicalize_url(raw_link)

        # Stable GUID: prefer entry id/guid, fallback to canonical URL, then raw link
        raw_guid = entry.get("id") or entry.get("guid") or article_url or raw_link
        guid = clean_html_text(str(raw_guid))

        # Skip entries that have neither title nor URL
        if not title and not article_url:
            continue

        published_at = parse_datetime(entry)

        # Clean summary from description or summary
        raw_summary = entry.get("summary") or entry.get("description") or ""
        summary = clean_html_text(raw_summary)
        # Cap summary length to avoid large blobs in database (max 2000 chars)
        if len(summary) > 2000:
            summary = summary[:1997] + "..."

        author = clean_html_text(entry.get("author") or entry.get("dc_creator", "ECDC"))
        categories = [
            clean_html_text(tag.get("term", ""))
            for tag in entry.get("tags", [])
            if tag.get("term")
        ]

        items.append(
            AnnouncementItem(
                feed_key=feed_config.key,
                feed_name=feed_display_name,
                feed_url=feed_config.url,
                guid=guid,
                title=title,
                article_url=article_url,
                published_at=published_at,
                summary=summary,
                author=author,
                categories=categories,
                raw_metadata={
                    "author": author,
                    "categories": categories,
                },
            )
        )

    return items

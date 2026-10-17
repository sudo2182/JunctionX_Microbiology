"""Robust HTTP fetcher for external RSS/Atom feeds with SSL and timeout protection."""

from __future__ import annotations

import logging
import ssl
import urllib.error
import urllib.request
from dataclasses import dataclass

try:
    import certifi
    _CAFILE = certifi.where()
except ImportError:
    _CAFILE = None

from pipeline.announcements.config import DEFAULT_TIMEOUT_SECONDS, DEFAULT_USER_AGENT

log = logging.getLogger("pipeline.announcements.fetcher")


class FeedFetchError(Exception):
    """Raised when fetching an external feed fails."""

    def __init__(self, url: str, message: str, status_code: int | None = None) -> None:
        super().__init__(f"Failed to fetch {url}: {message}")
        self.url = url
        self.message = message
        self.status_code = status_code


@dataclass
class FetchResult:
    content: str
    status_code: int
    etag: str | None = None
    last_modified: str | None = None
    not_modified: bool = False


def _create_ssl_context() -> ssl.SSLContext:
    if _CAFILE:
        return ssl.create_default_context(cafile=_CAFILE)
    return ssl.create_default_context()


def fetch_feed(
    url: str,
    timeout: int = DEFAULT_TIMEOUT_SECONDS,
    etag: str | None = None,
    last_modified: str | None = None,
    user_agent: str = DEFAULT_USER_AGENT,
) -> FetchResult:
    """Fetch feed XML with sensible timeouts, SSL context, and HTTP headers."""
    headers = {
        "User-Agent": user_agent,
        "Accept": "application/rss+xml, application/atom+xml, text/xml, application/xml;q=0.9, */*;q=0.8",
    }
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified

    req = urllib.request.Request(url, headers=headers)
    ssl_context = _create_ssl_context()

    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ssl_context) as resp:
            status = resp.status
            resp_etag = resp.headers.get("ETag")
            resp_last_modified = resp.headers.get("Last-Modified")
            raw_bytes = resp.read()

            # Handle charset detection with fallback to utf-8
            charset = resp.headers.get_content_charset() or "utf-8"
            try:
                content = raw_bytes.decode(charset, errors="replace")
            except Exception:
                content = raw_bytes.decode("utf-8", errors="replace")

            return FetchResult(
                content=content,
                status_code=status,
                etag=resp_etag,
                last_modified=resp_last_modified,
                not_modified=False,
            )

    except urllib.error.HTTPError as exc:
        if exc.code == 304:
            return FetchResult(
                content="",
                status_code=304,
                etag=etag,
                last_modified=last_modified,
                not_modified=True,
            )
        raise FeedFetchError(url, f"HTTP {exc.code}: {exc.reason}", status_code=exc.code) from exc

    except urllib.error.URLError as exc:
        raise FeedFetchError(url, f"Network error: {exc.reason}") from exc

    except TimeoutError as exc:
        raise FeedFetchError(url, "Request timed out") from exc

    except Exception as exc:
        raise FeedFetchError(url, f"Unexpected error: {exc}") from exc

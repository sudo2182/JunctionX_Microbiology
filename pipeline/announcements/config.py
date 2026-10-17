"""Feed configuration and constants for external surveillance announcement monitors."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class FeedConfig:
    key: str
    name: str
    url: str
    priority: int = 10
    enabled: bool = True


DEFAULT_USER_AGENT = os.environ.get(
    "AMR_MONITOR_USER_AGENT",
    "AMR-Watch-Surveillance-Monitor/1.0 (+https://github.com/sudo2182/JunctionX_Microbiology)",
)

DEFAULT_TIMEOUT_SECONDS = int(os.environ.get("ECDC_FEED_TIMEOUT", "20"))


# Official feeds verified against https://www.ecdc.europa.eu/en/rss-feeds
DEFAULT_ECDC_FEEDS: list[FeedConfig] = [
    FeedConfig(
        key="surveillance",
        name="Surveillance reports",
        url="https://www.ecdc.europa.eu/en/taxonomy/term/1253/feed",
        priority=1,
    ),
    FeedConfig(
        key="publications",
        name="Scientific and technical publications",
        url="https://www.ecdc.europa.eu/en/taxonomy/term/1244/feed",
        priority=2,
    ),
    FeedConfig(
        key="threats_cdtr",
        name="Communicable Disease Threats Report (CDTR)",
        url="https://www.ecdc.europa.eu/en/taxonomy/term/1505/feed",
        priority=3,
    ),
    FeedConfig(
        key="aer",
        name="Annual epidemiological reports (AER)",
        url="https://www.ecdc.europa.eu/en/taxonomy/term/1502/feed",
        priority=4,
    ),
    FeedConfig(
        key="risk_assessments",
        name="Risk assessments",
        url="https://www.ecdc.europa.eu/en/taxonomy/term/1295/feed",
        priority=5,
    ),
    FeedConfig(
        key="news",
        name="News and press releases",
        url="https://www.ecdc.europa.eu/en/taxonomy/term/1307/feed",
        priority=6,
    ),
]


def get_default_feeds() -> list[FeedConfig]:
    """Return enabled feed configurations ordered by priority."""
    return sorted([f for f in DEFAULT_ECDC_FEEDS if f.enabled], key=lambda f: f.priority)

"""ECDC RSS announcement checker and AMR relevance monitor (§BUILD_PLAN external benchmarks & surveillance)."""

from pipeline.announcements.config import FeedConfig, get_default_feeds
from pipeline.announcements.filter import RelevanceCategory, classify_announcement
from pipeline.announcements.parser import AnnouncementItem, parse_feed
from pipeline.announcements.runner import run_checker

__all__ = [
    "AnnouncementItem",
    "FeedConfig",
    "RelevanceCategory",
    "classify_announcement",
    "get_default_feeds",
    "parse_feed",
    "run_checker",
]

"""RSS 2.0 alert feeds (BUILD_PLAN section 8).

Reads alert episodes and their weekly firings, turns each open, escalation and
resolution into a feed item, and writes alerts.xml, alerts-high.xml, per-ward,
per-phenotype and per-organism feeds. Feeds carry aggregate data only.
"""

from pipeline.feeds.events import FeedEvent, events_from_episodes
from pipeline.feeds.render import render_feed
from pipeline.feeds.select import build_feeds

__all__ = ["FeedEvent", "build_feeds", "events_from_episodes", "render_feed"]

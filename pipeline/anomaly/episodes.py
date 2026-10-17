"""Group weekly alerts into episodes (BUILD_PLAN §7.6).

A key that fires in consecutive weeks updates one episode instead of creating new
alerts. Episodes go open -> escalated (severity or confidence rose) -> resolved
(no firing for ``quiet_weeks`` consecutive weeks). Acknowledge / dismiss are user
actions stored by the app, not decided here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .data import week_label

if TYPE_CHECKING:
    from .engine import Alert

SEVERITY_ORDER = {"low": 0, "medium": 1, "high": 2, "critical": 3}
CONFIDENCE_ORDER = {"low": 0, "medium": 1, "high": 2}


@dataclass
class Episode:
    key: str
    opened_week: int
    last_fired_week: int
    severity: str
    confidence: str
    rank: float
    status: str = "open"
    resolved_week: int | None = None
    firings: list[Alert] = field(default_factory=list)

    @property
    def episode_id(self) -> str:
        return f"E-{week_label(self.opened_week)}-{self.key}"

    def to_dict(self) -> dict[str, Any]:
        return {
            "episode_id": self.episode_id,
            "key": self.key,
            "opened_week": self.opened_week,
            "last_fired_week": self.last_fired_week,
            "resolved_week": self.resolved_week,
            "status": self.status,
            "severity": self.severity,
            "confidence": self.confidence,
            "rank": self.rank,
            "n_firings": len(self.firings),
        }

    def to_feed_dict(self) -> dict[str, Any]:
        """agg.alert_episodes row plus its agg.alert_firings, the shape pipeline.feeds reads."""
        return {
            **self.to_dict(),
            "firings": [{"week_idx": a.week_idx, "evidence": a.to_dict()} for a in self.firings],
        }


def build_episodes(alerts: list[Alert], through_week: int, quiet_weeks: int = 2) -> list[Episode]:
    """Fold alerts (any order) into episodes as they stand at ``through_week``."""
    open_by_key: dict[str, Episode] = {}
    episodes: list[Episode] = []
    for a in sorted(alerts, key=lambda a: a.week_idx):
        ep = open_by_key.get(a.key)
        if ep and a.week_idx - ep.last_fired_week > quiet_weeks:
            ep.status, ep.resolved_week = "resolved", ep.last_fired_week + quiet_weeks
            ep = None
        if ep is None:
            ep = Episode(a.key, a.week_idx, a.week_idx, a.severity, a.confidence, a.rank)
            open_by_key[a.key] = ep
            episodes.append(ep)
        else:
            if (
                SEVERITY_ORDER[a.severity] > SEVERITY_ORDER[ep.severity]
                or CONFIDENCE_ORDER[a.confidence] > CONFIDENCE_ORDER[ep.confidence]
            ):
                ep.status = "escalated"
            ep.severity = max(ep.severity, a.severity, key=SEVERITY_ORDER.get)
            ep.confidence = max(ep.confidence, a.confidence, key=CONFIDENCE_ORDER.get)
            ep.rank = max(ep.rank, a.rank)
            ep.last_fired_week = a.week_idx
        ep.firings.append(a)
    for ep in episodes:
        if ep.status != "resolved" and through_week - ep.last_fired_week >= quiet_weeks:
            ep.status, ep.resolved_week = "resolved", ep.last_fired_week + quiet_weeks
    return episodes

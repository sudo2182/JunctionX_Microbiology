"""Turn alert episodes into feed events (BUILD_PLAN 8.2).

An episode is a dict shaped like one row of agg.alert_episodes plus its firings
from agg.alert_firings, oldest first:

    {"episode_id": "...", "status": "open|escalated|resolved|acknowledged|dismissed",
     "severity": "high", "confidence": "high", "last_fired_week": 94,
     "resolved_week": 96,                      # optional
     "firings": [{"week_idx": 90, "evidence": {...section 7.4 JSON...}}, ...]}

Each firing's evidence carries the section 7.4 fields plus, ideally, its own
"severity" (band string, or {"band": ..., "points": ...}), "confidence" and
"rank". When a firing lacks them, the episode-level values are used.

Events:
  opened     the first firing                                   guid ...:r1
  escalated  a later firing whose severity band or confidence   guid ...:r2, r3, ...
             is higher than any earlier firing of the episode
  resolved   episode status 'resolved' (2 quiet weeks)          guid ...:resolved
Repeat firings at the same level publish nothing.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from pipeline.feeds.weeks import week_label

SEVERITY_ORDER = {"low": 1, "medium": 2, "high": 3, "critical": 4}
CONFIDENCE_ORDER = {"low": 1, "medium": 2, "high": 3}
CONFIDENCE_WEIGHT = {"low": 0.4, "medium": 0.7, "high": 1.0}


@dataclass
class FeedEvent:
    guid: str
    alert_id: str
    episode_id: str
    kind: str  # opened | escalated | resolved
    week_idx: int
    severity: str
    confidence: str
    rank: float
    evidence: dict[str, Any]
    opened_week_idx: int
    categories: list[str] = field(default_factory=list)

    @property
    def week(self) -> str:
        return week_label(self.week_idx)

    @property
    def scope(self) -> tuple[str, str]:
        scope = self.evidence.get("scope") or {}
        return scope.get("type", "hospital"), scope.get("value", "ALL")

    @property
    def marker(self) -> str | None:
        return self.evidence.get("marker")

    @property
    def organism(self) -> str | None:
        return self.evidence.get("organism")


def _band(value: Any) -> str | None:
    if isinstance(value, dict):
        value = value.get("band")
    return str(value).lower() if value else None


def _level(firing: dict, episode: dict) -> tuple[str, str, float | None]:
    ev = firing.get("evidence") or {}
    severity = _band(ev.get("severity")) or _band(firing.get("severity")) or _band(episode.get("severity"))
    confidence = _band(ev.get("confidence")) or _band(firing.get("confidence")) or _band(episode.get("confidence"))
    if severity not in SEVERITY_ORDER:
        raise ValueError(f"episode {episode.get('episode_id')}: unknown severity {severity!r}")
    if confidence not in CONFIDENCE_ORDER:
        raise ValueError(f"episode {episode.get('episode_id')}: unknown confidence {confidence!r}")
    rank = ev.get("rank", firing.get("rank"))
    return severity, confidence, rank


def _rank(severity_points: Any, severity: str, confidence: str, rank: Any) -> float:
    if rank is not None:
        return float(rank)
    points = severity_points if isinstance(severity_points, (int, float)) else SEVERITY_ORDER[severity] * 2
    return points * CONFIDENCE_WEIGHT[confidence]


def episode_events(episode: dict, through_week: int | None = None) -> list[FeedEvent]:
    firings = sorted(episode.get("firings") or [], key=lambda f: f["week_idx"])
    if through_week is not None:
        firings = [f for f in firings if f["week_idx"] <= through_week]
    if not firings:
        return []

    first_ev = firings[0].get("evidence") or {}
    alert_id = first_ev.get("alert_id") or str(episode["episode_id"])
    opened = firings[0]["week_idx"]
    events: list[FeedEvent] = []
    best_sev = best_conf = 0
    revision = 0

    for firing in firings:
        severity, confidence, rank = _level(firing, episode)
        sev_n, conf_n = SEVERITY_ORDER[severity], CONFIDENCE_ORDER[confidence]
        if revision and sev_n <= best_sev and conf_n <= best_conf:
            continue
        revision += 1
        best_sev, best_conf = max(best_sev, sev_n), max(best_conf, conf_n)
        ev = firing.get("evidence") or {}
        points = ev.get("severity", {}).get("points") if isinstance(ev.get("severity"), dict) else None
        events.append(
            FeedEvent(
                guid=f"amr-watch:{alert_id}:r{revision}",
                alert_id=alert_id,
                episode_id=str(episode["episode_id"]),
                kind="opened" if revision == 1 else "escalated",
                week_idx=firing["week_idx"],
                severity=severity,
                confidence=confidence,
                rank=_rank(points, severity, confidence, rank),
                evidence=ev,
                opened_week_idx=opened,
            )
        )

    if str(episode.get("status", "")).lower() == "resolved":
        last = firings[-1]
        resolved_week = episode.get("resolved_week") or (episode.get("last_fired_week") or last["week_idx"]) + 2
        if through_week is None or resolved_week <= through_week:
            severity, confidence, rank = _level(last, episode)
            events.append(
                FeedEvent(
                    guid=f"amr-watch:{alert_id}:resolved",
                    alert_id=alert_id,
                    episode_id=str(episode["episode_id"]),
                    kind="resolved",
                    week_idx=resolved_week,
                    severity=severity,
                    confidence=confidence,
                    rank=0.0,
                    evidence=last.get("evidence") or {},
                    opened_week_idx=opened,
                )
            )
    return events


def events_from_episodes(episodes: list[dict], through_week: int | None = None) -> list[FeedEvent]:
    """All feed events, newest week first, then highest rank."""
    events = [e for ep in episodes for e in episode_events(ep, through_week)]
    events.sort(key=lambda e: (-e.week_idx, -e.rank, e.guid))
    return events

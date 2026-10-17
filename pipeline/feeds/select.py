"""Which events go into which feed (BUILD_PLAN 8.1)."""

from __future__ import annotations

from dataclasses import dataclass

from pipeline.feeds.events import FeedEvent
from pipeline.feeds.labels import ORGANISMS, PHENOTYPES, WARDS, short_organism, slug

MAX_ITEMS = 50
SITE = "AMR Watch"
NOTE = "Weekly laboratory-based antimicrobial resistance alerts (synthetic hackathon data). Aggregate data only."


@dataclass
class FeedSpec:
    name: str
    title: str
    description: str
    channel_path: str
    events: list[FeedEvent]


def _is_high(e: FeedEvent) -> bool:
    return e.severity in ("high", "critical") and e.kind != "resolved"


def build_feeds(
    events: list[FeedEvent],
    wards: dict[str, str] | None = None,
    organisms: list[str] | None = None,
    max_items: int = MAX_ITEMS,
) -> list[FeedSpec]:
    """Every feed, including empty ones, so subscribe URLs always resolve.

    `events` must already be sorted newest first (events_from_episodes does this).
    """
    wards = wards or WARDS
    organisms = sorted(set(organisms or ORGANISMS) | {e.organism for e in events if e.organism})
    specs = [
        FeedSpec("alerts", f"{SITE}: all resistance alerts", NOTE, "/alerts", events),
        FeedSpec(
            "alerts-high",
            f"{SITE}: high-priority resistance alerts",
            NOTE + " High and Critical only.",
            "/alerts?severity=high",
            [e for e in events if _is_high(e)],
        ),
    ]
    for code, ward_name in wards.items():
        specs.append(
            FeedSpec(
                f"ward-{code}",
                f"{SITE}: {ward_name} alerts",
                NOTE + f" Alerts scoped to {ward_name}, plus hospital-wide Critical alerts.",
                f"/alerts?ward={code}",
                [
                    e
                    for e in events
                    if e.scope == ("ward", code) or (e.scope[0] == "hospital" and e.severity == "critical")
                ],
            )
        )
    for marker in PHENOTYPES:
        specs.append(
            FeedSpec(
                marker.lower(),
                f"{SITE}: {marker} alerts",
                NOTE + f" {marker} signals in any ward or scope.",
                f"/alerts?marker={marker}",
                [e for e in events if (e.marker or "").upper() == marker],
            )
        )
    for org in organisms:
        specs.append(
            FeedSpec(
                f"organism-{slug(org)}",
                f"{SITE}: {short_organism(org)} alerts",
                NOTE + f" Signals for {org}.",
                f"/alerts?organism={slug(org)}",
                [e for e in events if e.organism == org],
            )
        )
    for spec in specs:
        spec.events = spec.events[:max_items]
    return specs

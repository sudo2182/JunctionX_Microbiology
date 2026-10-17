"""Severity, confidence and rank (BUILD_PLAN §7.5)."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .config import (
    CONFIDENCE_WEIGHT,
    COUNT_RULES,
    FIRST_LINE_AGENTS,
    PRIORITY_AGENTS,
    PRIORITY_MARKERS,
    severity_band,
)

if TYPE_CHECKING:
    from .engine import Alert

RULE_ORGANISMS = {r.name: r.organisms for r in COUNT_RULES}


def _organisms(alert: Alert) -> tuple[str, ...]:
    return RULE_ORGANISMS.get(alert.organism, (alert.organism,))


def is_priority(alert: Alert) -> bool:
    if alert.marker in PRIORITY_MARKERS:
        return True
    orgs = PRIORITY_AGENTS.get(alert.marker, ())
    return any(o in orgs for o in _organisms(alert))


def severity_points(alert: Alert) -> tuple[int, list[str]]:
    ev = alert.evidence
    reasons: list[str] = []
    pts = 0
    if is_priority(alert):
        pts += 3
        reasons.append("priority phenotype +3")
    specimens = ev.get("breakdown", {}).get("specimen", {})
    if alert.specimen == "blood" or specimens.get("blood"):
        pts += 3
        reasons.append("blood isolate +3")
    if alert.marker in FIRST_LINE_AGENTS.get(alert.specimen, set()):
        pts += 2
        reasons.append("first-line empiric agent +2")
    effect = ev.get("effect") or {}
    if alert.type in ("rate", "drift") and effect.get("abs_pp", 0) >= 15:
        pts += 2
        reasons.append("increase >= 15 pp +2")
    if alert.type == "count" and effect.get("ratio", 0) >= 3:
        pts += 2
        reasons.append("count >= 3x expected +2")
    onset = ev.get("breakdown", {}).get("onset", {})
    if onset and onset.get("hospital", 0) > sum(onset.values()) / 2:
        pts += 1
        reasons.append("hospital-onset majority +1")
    if ev.get("distinct_patients", 0) >= 5:
        pts += 1
        reasons.append(">= 5 distinct patients +1")
    return pts, reasons


def confidence(alert: Alert) -> str:
    ev = alert.evidence
    if alert.type == "rate":
        q, n = ev["test"]["q"], ev["current"]["n"]
        if q < 0.001 and n >= 50:
            return "high"
        return "medium" if q < 0.01 else "low"
    if alert.type == "count":
        p, k = ev["test"]["p"], ev["current"]["k"]
        if k <= 3:
            return "low"
        if p < 0.001 and k >= 5:
            return "high"
        return "medium" if p < 0.01 else "low"
    return "low"  # sentinel and drift


def score(alert: Alert) -> None:
    pts, reasons = severity_points(alert)
    if alert.type == "drift":
        band = "low"  # informational by design
    else:
        band = severity_band(pts)
        if alert.type == "sentinel" and alert.marker == "CPE" and band in ("low", "medium"):
            band = "high"
            pts = max(pts, 5)
    alert.severity_points = pts
    alert.severity = band
    alert.confidence = confidence(alert)
    alert.rank = round(pts * CONFIDENCE_WEIGHT[alert.confidence], 2)
    alert.evidence["severity_reasons"] = reasons

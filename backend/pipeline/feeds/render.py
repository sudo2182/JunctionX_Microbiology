"""Render feed events as RSS 2.0 (BUILD_PLAN 8.3), aggregate data only (8.5)."""

from __future__ import annotations

import datetime as dt
import re
import xml.etree.ElementTree as ET
from email.utils import format_datetime
from typing import Any
from urllib.parse import quote

from pipeline.feeds.events import FeedEvent
from pipeline.feeds.labels import ANTIBIOTICS, scope_label, short_organism
from pipeline.feeds.weeks import week_label

ATOM_NS = "http://www.w3.org/2005/Atom"
AMR_NS = "https://amr-watch.example/ns"
ET.register_namespace("atom", ATOM_NS)
ET.register_namespace("amr", AMR_NS)

DISCLAIMER = "Aggregate surveillance signal for review; not individual treatment advice."


class PrivacyError(ValueError):
    """Raised when rendered feed text looks like it carries patient-level data."""


# Patient / culture / isolate ids from the LIS export, exact dates, and field names
# that only exist at patient level. Feeds use ISO weeks as the smallest time unit.
_FORBIDDEN = [
    (re.compile(r"\bP\d{6}\b"), "patient id"),
    (re.compile(r"\bC\d{7}(-\d+)?\b"), "culture or isolate id"),
    (re.compile(r"\b(19|20)\d{2}-\d{2}-\d{2}\b"), "exact date"),
    (re.compile(r"patient_id|birth_year|sample_date|admission_date", re.IGNORECASE), "patient-level field"),
]


def assert_aggregate_only(text: str) -> None:
    for pattern, what in _FORBIDDEN:
        m = pattern.search(text)
        if m:
            raise PrivacyError(f"feed text contains a {what}: {m.group(0)!r}")


def _pct(v: Any) -> str:
    return f"{float(v):.1f}%"


def _num(v: Any) -> str:
    f = float(v)
    return f"{f:.0f}" if f.is_integer() else f"{f:.1f}"


def _p(test: dict) -> str:
    key = "q" if test.get("q") is not None else "p"
    val = test.get(key)
    if val is None:
        return ""
    return f"{key} < 0.001" if val < 0.001 else f"{key} = {val:.3f}"


def _window(ev: dict) -> str:
    weeks = (ev.get("current") or {}).get("weeks", "")
    return weeks.replace("..", "/")


def _what(ev: dict) -> str:
    if ev.get("marker"):
        return ev["marker"]
    code = ev.get("antibiotic_code") or ev.get("antibiotic") or ""
    return ANTIBIOTICS.get(code, code)


def _subject(ev: dict, wards: dict[str, str] | None) -> str:
    scope = ev.get("scope") or {}
    where = scope_label(scope.get("type", "hospital"), scope.get("value", "ALL"), wards)
    org = short_organism(ev.get("organism", "unknown organism"))
    specimen = ev.get("specimen")
    org_spec = f"{org} {specimen}" if specimen and specimen != "all" else org
    return f"{where} · {org_spec}"


def _count_values(ev: dict) -> tuple[Any, Any]:
    cur = ev.get("current") or {}
    k = cur.get("k", cur.get("count", cur.get("x")))
    exp = ev.get("expected")
    if isinstance(exp, dict):
        exp = exp.get("count", exp.get("lambda"))
    if exp is None:
        exp = (ev.get("baseline") or {}).get("expected")
    return k, exp


def _measure(ev: dict) -> str:
    """Short 'what changed' phrase for the title."""
    kind = ev.get("type", "rate")
    what = _what(ev)
    if kind in ("count", "sentinel"):
        k, exp = _count_values(ev)
        unit = "isolate" if k == 1 else "isolates"
        if kind == "sentinel" or exp is None:
            return f"{what} sentinel: {k} {unit}"
        return f"{what} {k} {unit} (expected {_num(exp)})"
    cur, base = ev.get("current") or {}, ev.get("baseline") or {}
    label = f"{what} share" if ev.get("marker") else f"{what} resistance"
    if kind == "drift":
        label = f"{label} drift"
    return f"{label} {_pct(cur['pct'])} (was {_pct(base['pct'])})"


def item_title(event: FeedEvent, wards: dict[str, str] | None = None) -> str:
    ev = event.evidence
    subject = _subject(ev, wards)
    if event.kind == "resolved":
        return f"[RESOLVED] {subject} · {_what(ev)} back to baseline"
    suffix = " (escalated)" if event.kind == "escalated" else ""
    return f"[{event.severity.upper()}] {subject} · {_measure(ev)}{suffix}"


def item_description(event: FeedEvent, wards: dict[str, str] | None = None) -> str:
    ev = event.evidence
    scope = ev.get("scope") or {}
    where = scope_label(scope.get("type", "hospital"), scope.get("value", "ALL"), wards)
    org = short_organism(ev.get("organism", "unknown organism"))
    specimen = ev.get("specimen")
    specimen = "all specimens" if specimen in (None, "", "all") else specimen
    head = f"{where}, {specimen}, {org}"
    cur, base = ev.get("current") or {}, ev.get("baseline") or {}
    effect, test = ev.get("effect") or {}, ev.get("test") or {}
    what = _what(ev)
    kind = ev.get("type", "rate")
    parts: list[str] = []

    if event.kind == "resolved":
        parts.append(
            f"{head}: the {what} signal opened in {week_label(event.opened_week_idx)} has not fired for "
            f"2 consecutive weeks and is treated as back to baseline as of {event.week}."
        )
    elif kind in ("count", "sentinel"):
        k, exp = _count_values(ev)
        line = f"{head}: {k} {what} isolate{'s' if k != 1 else ''} in {cur.get('weeks', event.week)}"
        if exp is not None and kind == "count":
            line += f" against {_num(exp)} expected from the previous 52 weeks"
            if effect.get("ratio") is not None:
                line += f" ({float(effect['ratio']):.1f}x)"
        else:
            line += " (sentinel event, reported on first occurrence)"
        parts.append(line + ".")
    else:
        label = f"{what} share" if ev.get("marker") else f"{what} resistance"
        ci = cur.get("ci")
        ci_txt = f", 95% CI {float(ci[0]):.1f}–{float(ci[1]):.1f}%" if ci else ""
        base_span = base.get("weeks", "the previous 52 weeks") if kind == "drift" else "the previous 52 weeks"
        parts.append(
            f"{head}: {label} {_pct(cur['pct'])} ({cur.get('x')}/{cur.get('n')}{ci_txt}) in "
            f"{cur.get('weeks', event.week)} vs {_pct(base['pct'])} ({base.get('x')}/{base.get('n')}) in {base_span}."
        )
        if effect.get("abs_pp") is not None:
            parts.append(f"{float(effect['abs_pp']):+.1f} pp.")

    if event.kind != "resolved":
        sig = _p(test)
        parts.append(f"Severity: {event.severity}. Confidence: {event.confidence}{f' ({sig})' if sig else ''}.")
        patients = ev.get("distinct_patients")
        onset = ((ev.get("breakdown") or {}).get("onset") or {}).get("hospital")
        if patients is not None:
            pt = f"{patients} distinct patient{'s' if patients != 1 else ''}"
            if onset is not None:
                pt += f", {onset} hospital-onset"
            parts.append(pt + ".")
        opened = f"Opened {week_label(event.opened_week_idx)}."
        if event.kind == "escalated":
            opened = f"Escalated {event.week}; opened {week_label(event.opened_week_idx)}."
        parts.append(opened)
    parts.append(DISCLAIMER)
    return " ".join(parts)


def item_link(event: FeedEvent, base_url: str) -> str:
    return f"{base_url.rstrip('/')}/alerts/{quote(event.alert_id, safe='')}?week={event.week}"


def item_categories(event: FeedEvent) -> list[str]:
    ev = event.evidence
    scope_type, scope_value = event.scope
    cats = [f"severity:{event.severity}", f"confidence:{event.confidence}", f"event:{event.kind}"]
    cats.append(f"ward:{scope_value}" if scope_type == "ward" else f"scope:{scope_type}:{scope_value}")
    if ev.get("organism"):
        cats.append(f"organism:{ev['organism']}")
    if ev.get("marker"):
        cats.append(f"marker:{ev['marker']}")
    elif ev.get("antibiotic_code"):
        cats.append(f"antibiotic:{ev['antibiotic_code']}")
    if ev.get("specimen"):
        cats.append(f"specimen:{ev['specimen']}")
    return cats


def _sub(parent: ET.Element, tag: str, text: str | None = None, **attrib: str) -> ET.Element:
    el = ET.SubElement(parent, tag, attrib)
    if text is not None:
        el.text = text
    return el


def render_feed(
    *,
    name: str,
    title: str,
    description: str,
    events: list[FeedEvent],
    base_url: str,
    channel_path: str = "/alerts",
    build_time: dt.datetime,
    published_at: dict[str, dt.datetime] | None = None,
    wards: dict[str, str] | None = None,
    ttl_minutes: int = 60,
) -> bytes:
    """Render one feed. `published_at` maps guid -> first publication time (agg.feed_log)."""
    published_at = published_at or {}
    base = base_url.rstrip("/")
    rss = ET.Element("rss", {"version": "2.0"})
    ch = _sub(rss, "channel")
    _sub(ch, "title", title)
    _sub(ch, "link", f"{base}{channel_path}")
    _sub(ch, f"{{{ATOM_NS}}}link", href=f"{base}/feed/{name}.xml", rel="self", type="application/rss+xml")
    _sub(ch, "description", description)
    _sub(ch, "language", "en")
    _sub(ch, "lastBuildDate", format_datetime(build_time))
    _sub(ch, "ttl", str(ttl_minutes))

    for event in events:
        it = _sub(ch, "item")
        _sub(it, "title", item_title(event, wards))
        _sub(it, "link", item_link(event, base))
        _sub(it, "guid", event.guid, isPermaLink="false")
        _sub(it, "pubDate", format_datetime(published_at.get(event.guid, build_time)))
        for cat in item_categories(event):
            _sub(it, "category", cat)
        _sub(it, "description", item_description(event, wards))
        _sub(it, f"{{{AMR_NS}}}event", event.kind)
        _sub(it, f"{{{AMR_NS}}}severity", event.severity)
        _sub(it, f"{{{AMR_NS}}}confidence", event.confidence)
        window = _window(event.evidence)
        if window:
            _sub(it, f"{{{AMR_NS}}}window", window)
        _sub(it, f"{{{AMR_NS}}}week", event.week)

    ET.indent(rss)
    xml = ET.tostring(rss, encoding="utf-8", xml_declaration=True)
    assert_aggregate_only(xml.decode("utf-8"))
    return xml

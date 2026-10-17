import datetime as dt
import json
from pathlib import Path

import feedparser
import pytest

from pipeline.feeds.events import episode_events, events_from_episodes
from pipeline.feeds.publish import feed_log_rows, generate, load_episodes_json
from pipeline.feeds.render import PrivacyError, assert_aggregate_only
from pipeline.feeds.weeks import week_idx_from_label, week_label

FIXTURE = Path(__file__).parent / "fixtures" / "episodes.json"
NOW = dt.datetime(2026, 3, 16, 6, 0, tzinfo=dt.UTC)
BASE = "https://amr-watch.vercel.app"


@pytest.fixture(scope="module")
def episodes():
    eps, cursor = load_episodes_json(FIXTURE)
    assert cursor == 130
    return eps


@pytest.fixture(scope="module")
def files(episodes):
    return generate(episodes, base_url=BASE, through_week=130, now=NOW)


def parsed(files, name):
    feed = feedparser.parse(files[name])
    assert not feed.bozo, feed.get("bozo_exception")
    return feed


def by_id(episodes, ep_id):
    return next(e for e in episodes if e["episode_id"] == ep_id)


def test_week_labels_match_replay_calendar():
    assert week_label(1) == "2023-W40"
    assert week_label(53) == "2024-W40"
    assert week_label(85) == "2025-W20"
    assert week_label(88) == "2025-W23"
    assert week_label(127) == "2026-W10"
    assert week_label(156) == "2026-W39"
    assert all(week_idx_from_label(week_label(i)) == i for i in range(1, 157))


def test_open_escalate_resolve_and_no_repeat_items(episodes):
    events = episode_events(by_id(episodes, "ep-uro-esbl"))
    kinds = [(e.kind, e.week_idx, e.severity) for e in events]
    # W24 medium opens, W25 high escalates, W26 high repeats (no item), W27 critical escalates,
    # W30 high repeat (no item), resolved two weeks after the last firing.
    assert kinds == [
        ("opened", 89, "medium"),
        ("escalated", 90, "high"),
        ("escalated", 92, "critical"),
        ("resolved", 97, "high"),
    ]
    guids = [e.guid for e in events]
    assert guids[0].endswith(":r1") and guids[1].endswith(":r2") and guids[2].endswith(":r3")
    assert guids[3].endswith(":resolved")
    assert len({g.rsplit(":", 1)[0] for g in guids}) == 1  # same guid prefix


def test_confidence_increase_alone_escalates():
    ev = {"alert_id": "A-X", "organism": "Escherichia coli", "marker": "ESBL"}
    ep = {
        "episode_id": "x",
        "status": "open",
        "firings": [
            {"week_idx": 10, "evidence": {**ev, "severity": "high", "confidence": "low"}},
            {"week_idx": 11, "evidence": {**ev, "severity": "high", "confidence": "medium"}},
            {"week_idx": 12, "evidence": {**ev, "severity": "medium", "confidence": "medium"}},
        ],
    }
    assert [e.kind for e in episode_events(ep)] == ["opened", "escalated"]


def test_episode_level_severity_is_fallback():
    ep = {
        "episode_id": "y",
        "status": "open",
        "severity": "High",
        "confidence": "low",
        "firings": [{"week_idx": 5, "evidence": {"organism": "Escherichia coli"}}],
    }
    (event,) = episode_events(ep)
    assert event.severity == "high" and event.guid == "amr-watch:y:r1"


def test_cursor_hides_future_firings_and_resolutions(episodes):
    events = events_from_episodes(episodes, through_week=91)
    assert not any(e.alert_id == "A-FUTURE" for e in events)
    assert not any(e.kind == "resolved" for e in events)  # resolves at 97
    assert max(e.week_idx for e in events) <= 91


def test_all_feeds_parse_without_errors(files):
    assert {
        "alerts.xml",
        "alerts-high.xml",
        "ward-URO.xml",
        "ward-ICU.xml",
        "mrsa.xml",
        "esbl.xml",
        "cpe.xml",
        "organism-escherichia-coli.xml",
    } <= set(files)
    for name in files:
        feed = parsed(files, name)
        assert feed.version == "rss20"
        assert feed.feed.title.startswith("AMR Watch")


def test_all_alerts_feed_newest_first(files):
    feed = parsed(files, "alerts.xml")
    weeks = [e["amr_week"] for e in feed.entries]
    assert weeks == sorted(weeks, reverse=True)
    assert len(feed.entries) == 8  # 4 URO + hosp CIP + ICU MRSA + CPE + PHC-N, no future
    assert not any("FUTURE" in e.id for e in feed.entries)


def test_high_feed_only_high_and_critical_and_no_resolves(files):
    feed = parsed(files, "alerts-high.xml")
    assert feed.entries
    for e in feed.entries:
        assert e["amr_severity"] in ("high", "critical")
        assert e["amr_event"] != "resolved"
    assert "amr-watch:A-2025W24-URO-ECOLI-URINE-ESBL:r1" not in {e.id for e in feed.entries}  # medium


def test_item_shape_matches_plan(files):
    feed = parsed(files, "ward-URO.xml")
    item = next(e for e in feed.entries if e.id.endswith(":r2"))
    assert item.title == "[HIGH] Urology · E. coli urine · ESBL share 34.1% (was 4.0%) (escalated)"
    assert item.link == f"{BASE}/alerts/A-2025W24-URO-ECOLI-URINE-ESBL?week=2025-W25"
    assert item.guidislink is False
    terms = {t.term for t in item.tags}
    assert {"severity:high", "ward:URO", "organism:Escherichia coli", "marker:ESBL", "specimen:urine"} <= terms
    d = item.description
    for needle in [
        "34.1%",
        "14/41",
        "95% CI 21.6–49.4%",
        "2025-W22..2025-W25",
        "4.0% (14/352)",
        "+30.1 pp",
        "Confidence: high (q < 0.001)",
        "14 distinct patients",
        "11 hospital-onset",
        "not individual treatment advice",
    ]:
        assert needle in d, needle
    assert item["amr_window"] == "2025-W22/2025-W25"
    assert item["amr_confidence"] == "high"


def test_count_alert_text(files):
    feed = parsed(files, "mrsa.xml")
    (item,) = feed.entries
    assert item.title == "[CRITICAL] Intensive care unit · S. aureus · MRSA 9 isolates (expected 0.9)"
    assert "9 MRSA isolates in 2026-W08..2026-W11 against 0.9 expected" in item.description
    assert "all specimens" in item.description


def test_ward_feed_scoping(files):
    uro = {e.id for e in parsed(files, "ward-URO.xml").entries}
    icu = {e.id for e in parsed(files, "ward-ICU.xml").entries}
    assert all("URO" in g for g in uro) and len(uro) == 4
    assert all("ICU" in g for g in icu)
    # hospital-wide medium CIP signal is not pushed into ward feeds
    assert not any("HOSP" in g for g in uro | icu)
    assert parsed(files, "ward-SURG.xml").entries == []


def test_ward_feed_includes_hospital_wide_critical(episodes):
    ep = json.loads(json.dumps(by_id(episodes, "ep-hosp-cip")))
    ep["firings"][0]["evidence"]["severity"] = {"band": "critical", "points": 7}
    out = generate([ep], base_url=BASE, now=NOW)
    for ward in ("URO", "ICU", "ED"):
        assert len(feedparser.parse(out[f"ward-{ward}.xml"]).entries) == 1


def test_published_at_is_stable_from_feed_log(episodes):
    first = dt.datetime(2025, 6, 23, 6, 0, tzinfo=dt.UTC)
    guid = "amr-watch:A-2025W24-URO-ECOLI-URINE-ESBL:r2"
    out = generate(episodes, base_url=BASE, through_week=130, now=NOW, published_at={guid: first})
    item = next(e for e in feedparser.parse(out["alerts.xml"]).entries if e.id == guid)
    assert item.published == "Mon, 23 Jun 2025 06:00:00 +0000"
    rows = feed_log_rows(out, {guid: first}, NOW)
    assert (guid, "alerts", first) in rows and (guid, "ward-URO", first) in rows


def test_max_50_items_per_feed():
    eps = [
        {
            "episode_id": f"e{i}",
            "status": "open",
            "firings": [
                {
                    "week_idx": 60 + i,
                    "evidence": {
                        "alert_id": f"A-{i}",
                        "organism": "Escherichia coli",
                        "marker": "ESBL",
                        "severity": "low",
                        "confidence": "low",
                        "scope": {"type": "ward", "value": "URO"},
                        "current": {"weeks": "x", "k": 1},
                        "type": "sentinel",
                    },
                }
            ],
        }
        for i in range(70)
    ]
    out = generate(eps, base_url=BASE, now=NOW)
    entries = feedparser.parse(out["alerts.xml"]).entries
    assert len(entries) == 50
    assert entries[0].id == "amr-watch:A-69:r1"


def test_no_patient_level_data_in_any_feed(files):
    for body in files.values():
        text = body.decode()
        assert "P00" not in text and "patient_id" not in text
        assert_aggregate_only(text)


@pytest.mark.parametrize("bad", ["P005095", "C0000003-1", "2025-06-18", "birth_year 1968"])
def test_privacy_guard_rejects_identifiers(bad):
    with pytest.raises(PrivacyError):
        assert_aggregate_only(f"<x>{bad}</x>")


def test_evidence_with_identifier_is_refused(episodes):
    ep = json.loads(json.dumps(by_id(episodes, "ep-phc-cip")))
    ep["firings"][0]["evidence"]["scope"]["value"] = "P005095"
    with pytest.raises(PrivacyError):
        generate([ep], base_url=BASE, now=NOW)

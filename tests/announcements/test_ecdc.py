"""Comprehensive test suite for ECDC RSS feed checker and AMR relevance detection."""

from __future__ import annotations

import unittest.mock as mock
from datetime import UTC, datetime

import pytest

from pipeline.announcements.config import FeedConfig
from pipeline.announcements.db import upsert_announcements
from pipeline.announcements.fetcher import FeedFetchError, fetch_feed
from pipeline.announcements.filter import (
    RelevanceCategory,
    classify_announcement,
)
from pipeline.announcements.parser import (
    AnnouncementItem,
    canonicalize_url,
    clean_html_text,
    parse_feed,
)
from pipeline.announcements.runner import run_checker

# Sample RSS 2.0 with various items (AMR relevant, review, unrelated, missing dates/guids)
SAMPLE_RSS_XML = """<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
  <channel>
    <title>ECDC Surveillance Reports</title>
    <link>https://www.ecdc.europa.eu/en</link>
    <description>Official surveillance reports</description>

    <item>
      <title>Antimicrobial resistance surveillance in Europe 2024 - annual report</title>
      <link>https://www.ecdc.europa.eu/en/publications-data/amr-surveillance-2024?utm_source=rss</link>
      <description>&lt;p&gt;Joint ECDC/WHO report on European AMR and EARS-Net findings.&lt;/p&gt;</description>
      <pubDate>Thu, 15 Oct 2026 12:00:00 +0200</pubDate>
      <dc:creator>ECDC</dc:creator>
      <guid isPermaLink="true">https://www.ecdc.europa.eu/node/12345</guid>
    </item>

    <item>
      <title>Hospital outbreak investigation of Acinetobacter baumannii</title>
      <link>https://www.ecdc.europa.eu/en/publications-data/hospital-outbreak-acinetobacter</link>
      <description>&lt;p&gt;Rapid response to nosocomial transmission in intensive care.&lt;/p&gt;</description>
      <pubDate>Wed, 14 Oct 2026 10:00:00 +0200</pubDate>
      <dc:creator>ECDC</dc:creator>
      <guid>acinetobacter-outbreak-2026</guid>
    </item>

    <item>
      <title>Seasonal surveillance of dengue in the EU/EEA</title>
      <link>https://www.ecdc.europa.eu/en/publications-data/dengue-2026</link>
      <description>&lt;p&gt;Vector-borne diseases update for Mediterranean regions.&lt;/p&gt;</description>
      <pubDate>Tue, 13 Oct 2026 09:30:00 +0200</pubDate>
      <guid>dengue-2026-guid</guid>
    </item>

    <item>
      <title>Item with missing pubdate and no guid</title>
      <link>https://www.ecdc.europa.eu/en/publications-data/no-guid-item</link>
      <description>Simple summary without dates or identifiers.</description>
    </item>
  </channel>
</rss>
"""

SAMPLE_ATOM_XML = """<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>ECDC Atom Feed</title>
  <link href="https://www.ecdc.europa.eu/en"/>
  <updated>2026-10-15T12:00:00Z</updated>
  <entry>
    <title>Guidance on Carbapenemase-producing Enterobacterales (CPE)</title>
    <link href="https://www.ecdc.europa.eu/en/guidance-cpe"/>
    <id>urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a</id>
    <updated>2026-10-15T12:00:00Z</updated>
    <summary>Infection prevention and control measures for CPE in healthcare settings.</summary>
    <author><name>ECDC Expert Panel</name></author>
  </entry>
</feed>
"""


# ---------------------------------------------------------------------------
# 1. Text & URL Normalization Tests
# ---------------------------------------------------------------------------

def test_clean_html_text():
    html_input = "<p>This is <strong>important</strong> &amp; urgent.<br>Second line.</p>"
    clean = clean_html_text(html_input)
    assert clean == "This is important & urgent. Second line."


def test_clean_html_empty():
    assert clean_html_text(None) == ""
    assert clean_html_text("") == ""


def test_canonicalize_url():
    url_with_tracking = "https://www.ecdc.europa.eu/en/report?utm_source=rss&utm_medium=feed&other=val"
    canonical = canonicalize_url(url_with_tracking)
    assert canonical == "https://www.ecdc.europa.eu/en/report?other=val"

    trailing_slash = "https://www.ecdc.europa.eu/en/report/"
    assert canonicalize_url(trailing_slash) == "https://www.ecdc.europa.eu/en/report"


# ---------------------------------------------------------------------------
# 2. Feed Parsing Tests (RSS 2.0 & Atom)
# ---------------------------------------------------------------------------

def test_parse_valid_rss():
    feed_cfg = FeedConfig(key="test", name="Test Feed", url="https://example.com/rss")
    items = parse_feed(SAMPLE_RSS_XML, feed_cfg)

    assert len(items) == 4
    first = items[0]
    assert first.title == "Antimicrobial resistance surveillance in Europe 2024 - annual report"
    assert first.article_url == "https://www.ecdc.europa.eu/en/publications-data/amr-surveillance-2024"
    assert first.guid == "https://www.ecdc.europa.eu/node/12345"
    assert first.published_at is not None
    assert first.published_at.year == 2026
    assert first.author == "ECDC"
    assert "EARS-Net" in first.summary


def test_parse_atom():
    feed_cfg = FeedConfig(key="atom_test", name="Atom Test", url="https://example.com/atom")
    items = parse_feed(SAMPLE_ATOM_XML, feed_cfg)

    assert len(items) == 1
    item = items[0]
    assert item.title == "Guidance on Carbapenemase-producing Enterobacterales (CPE)"
    assert item.guid == "urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a"
    assert item.published_at is not None
    assert item.author == "ECDC Expert Panel"


def test_parse_missing_dates_and_guid_fallback():
    feed_cfg = FeedConfig(key="fallback_test", name="Fallback Test", url="https://example.com/rss")
    items = parse_feed(SAMPLE_RSS_XML, feed_cfg)

    # Fourth item had missing pubDate and no guid
    fourth = items[3]
    assert fourth.title == "Item with missing pubdate and no guid"
    assert fourth.published_at is None
    # GUID falls back to canonical article URL
    assert fourth.guid == "https://www.ecdc.europa.eu/en/publications-data/no-guid-item"


def test_parse_empty_or_malformed_xml():
    feed_cfg = FeedConfig(key="empty", name="Empty Feed", url="https://example.com/empty")
    assert parse_feed("", feed_cfg) == []
    assert parse_feed("   ", feed_cfg) == []
    assert parse_feed("<not-rss>garbage</not-rss>", feed_cfg) == []


# ---------------------------------------------------------------------------
# 3. AMR Relevance Filter Tests (Word boundaries, false positives, variations)
# ---------------------------------------------------------------------------

@pytest.mark.parametrize(
    "text,expected_category,expected_term",
    [
        ("EU report on antimicrobial resistance in humans", RelevanceCategory.RELEVANT, "antimicrobial resistance"),
        ("New trends in antibiotic resistance across hospitals", RelevanceCategory.RELEVANT, "antibiotic resistance"),
        ("High-level AMR surveillance summary", RelevanceCategory.RELEVANT, "AMR"),
        ("Survey on carbapenem-resistant Enterobacterales", RelevanceCategory.RELEVANT, "carbapenem resistance"),
        ("Emergence of ESBL-producing strains in Europe", RelevanceCategory.RELEVANT, "ESBL"),
        ("Updated EARS-Net annual data release", RelevanceCategory.RELEVANT, "EARS-Net"),
        ("Incidence of MRSA in blood cultures", RelevanceCategory.RELEVANT, "MRSA"),
        ("Investigation of vancomycin-resistant enterococci", RelevanceCategory.RELEVANT, "vancomycin-resistant"),
        ("Colistin resistance gene detected in travel cohort", RelevanceCategory.RELEVANT, "colistin resistance"),
        ("Hospital stewardship guide for multi-drug resistant bugs", RelevanceCategory.RELEVANT, "multidrug-resistant"),
        (
            "Guidelines on antimicrobial consumption in tertiary centers",
            RelevanceCategory.RELEVANT,
            "antimicrobial consumption",
        ),
    ],
)
def test_relevance_positive_matches(text, expected_category, expected_term):
    cat, terms = classify_announcement(title=text, summary="")
    assert cat == expected_category.value
    assert any(expected_term.lower() in t.lower() for t in terms)


@pytest.mark.parametrize(
    "false_positive_text",
    [
        "Security camera footage released by local police",      # camera contains 'amr'
        "Paramedic service responds to emergency call",          # paramedic contains 'amr'
        "Pamphlet distributed on seasonal respiratory hygiene",  # pamphlet
        "Photographer with vintage camera in Paris",            # camera
        "Programme for regional healthcare seminar",             # unrelated
        "Dengue fever alert in southern European coastal areas",  # mosquito/vector
        "Avian influenza surveillance in wild bird populations", # virus
        "Mpox vaccination guidelines for at-risk populations",   # virus
    ],
)
def test_relevance_false_positive_prevention(false_positive_text):
    cat, terms = classify_announcement(title=false_positive_text, summary="")
    assert cat == RelevanceCategory.UNRELATED.value
    assert terms == []


def test_relevance_review_tier():
    # Pathogen or healthcare infection without explicit resistance keywords
    cat, terms = classify_announcement(
        title="Investigation of healthcare-associated infections in neonatal ward",
        summary="Acinetobacter baumannii cluster identified",
    )
    assert cat == RelevanceCategory.REVIEW.value
    assert "healthcare-associated infections" in terms
    assert "Acinetobacter baumannii" in terms


# ---------------------------------------------------------------------------
# 4. Fetcher Tests with Mocked HTTP
# ---------------------------------------------------------------------------

def test_fetch_feed_success():
    with mock.patch("urllib.request.urlopen") as mock_urlopen:
        mock_resp = mock.MagicMock()
        mock_resp.status = 200
        mock_resp.read.return_value = b"<rss><channel><title>OK</title></channel></rss>"
        mock_resp.headers.get.side_effect = lambda h: "etag-123" if h == "ETag" else None
        mock_resp.headers.get_content_charset.return_value = "utf-8"
        mock_urlopen.return_value.__enter__.return_value = mock_resp

        res = fetch_feed("https://test.ecdc.europa.eu/feed")
        assert res.status_code == 200
        assert "<title>OK</title>" in res.content
        assert res.etag == "etag-123"
        assert not res.not_modified


def test_fetch_feed_http_error():
    import urllib.error
    with mock.patch("urllib.request.urlopen") as mock_urlopen:
        mock_urlopen.side_effect = urllib.error.HTTPError(
            url="https://test.ecdc.europa.eu/feed",
            code=404,
            msg="Not Found",
            hdrs={},
            fp=None,
        )
        with pytest.raises(FeedFetchError) as exc_info:
            fetch_feed("https://test.ecdc.europa.eu/feed")
        assert exc_info.value.status_code == 404
        assert "HTTP 404" in str(exc_info.value)


# ---------------------------------------------------------------------------
# 5. Multi-Feed Resilience: One Feed Fails While Others Succeed
# ---------------------------------------------------------------------------

def test_runner_feed_failure_resilience():
    feed1 = FeedConfig(key="feed1", name="Good Feed", url="https://example.com/good")
    feed2 = FeedConfig(key="feed2", name="Failing Feed", url="https://example.com/bad")

    def mock_fetch(url, **kwargs):
        if url == "https://example.com/good":
            from pipeline.announcements.fetcher import FetchResult
            return FetchResult(content=SAMPLE_RSS_XML, status_code=200)
        raise FeedFetchError(url, "Simulated 500 Internal Server Error", status_code=500)

    with mock.patch("pipeline.announcements.runner.fetch_feed", side_effect=mock_fetch):
        summary = run_checker(feeds=[feed1, feed2], dry_run=True)

    metrics = summary["metrics"]
    assert metrics["feeds_checked"] == 2
    assert metrics["feeds_succeeded"] == 1
    assert metrics["feeds_failed"] == 1
    assert "feed2" in metrics["errors"]
    assert metrics["items_fetched"] == 4
    assert summary["status"] == "partial_success"


# ---------------------------------------------------------------------------
# 6. Database Upsert & Deduplication Tests
# ---------------------------------------------------------------------------

def test_db_upsert_idempotent():
    mock_conn = mock.MagicMock()
    mock_cursor = mock.MagicMock()
    mock_conn.cursor.return_value.__enter__.return_value = mock_cursor

    # Simulate 1 inserted (is_new=True), 1 updated (is_new=False)
    mock_cursor.fetchone.side_effect = [(True,), (False,)]

    item1 = AnnouncementItem(
        feed_key="test",
        feed_name="Test",
        feed_url="https://test.com",
        guid="item-1",
        title="First Report on AMR",
        article_url="https://test.com/1",
        published_at=datetime.now(UTC),
        summary="Summary 1",
    )
    item2 = AnnouncementItem(
        feed_key="test",
        feed_name="Test",
        feed_url="https://test.com",
        guid="item-2",
        title="Second Report on MRSA",
        article_url="https://test.com/2",
        published_at=datetime.now(UTC),
        summary="Summary 2",
    )

    items = [
        (item1, "relevant", ["AMR"]),
        (item2, "relevant", ["MRSA"]),
    ]

    stats = upsert_announcements(mock_conn, items, source_id="ecdc", store_unrelated=True)
    assert stats["inserted"] == 1
    assert stats["updated"] == 1
    assert mock_conn.commit.called

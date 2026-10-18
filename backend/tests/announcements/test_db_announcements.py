"""bench.announcements against a throwaway Postgres (skipped unless TEST_DATABASE_URL is set; the test wipes it)."""

import os
import unittest.mock as mock
from pathlib import Path

import psycopg
import pytest

from pipeline import db
from pipeline.announcements.config import FeedConfig
from pipeline.announcements.fetcher import FeedFetchError, FetchResult
from pipeline.announcements.runner import run_checker

URL = os.environ.get("TEST_DATABASE_URL")
ROOT = Path(__file__).resolve().parent.parent.parent
pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL not set")

FEED = FeedConfig(key="publications", name="Publications", url="https://example.com/feed")


def rss(*items: str) -> str:
    return f'<rss version="2.0"><channel><title>ECDC</title>{"".join(items)}</channel></rss>'


AMR = """<item><title>Antimicrobial resistance in the EU/EEA</title>
  <link>https://www.ecdc.europa.eu/en/publications-data/amr-2026</link>
  <guid>https://www.ecdc.europa.eu/en/publications-data/amr-2026</guid>
  <pubDate>Thu, 15 Oct 2026 12:00:00 +0200</pubDate><description>EARS-Net data.</description></item>"""
DENGUE = """<item><title>Dengue in Europe</title>
  <link>https://www.ecdc.europa.eu/en/publications-data/dengue</link>
  <guid>dengue-guid</guid><pubDate>Wed, 14 Oct 2026 10:00:00 +0200</pubDate></item>"""


def no_guid(link: str) -> str:
    return f"<item><title>ESBL update</title><link>{link}</link></item>"


@pytest.fixture
def conn():
    with psycopg.connect(URL, autocommit=True) as admin:
        admin.execute("drop schema if exists api, agg, bench, lab, staging, ref cascade")
        admin.execute((ROOT / "supabase" / "local_roles.sql").read_text())
        for f in sorted((ROOT / "supabase" / "migrations").glob("*.sql")):
            admin.execute(f.read_text())
    with db.connect(URL) as c:
        yield c


def run(conn, content: str | None, feeds=(FEED,)):
    def fake(url, **kwargs):
        if content is None:
            raise FeedFetchError(url, "Simulated outage")
        return FetchResult(content=content, status_code=200)

    with mock.patch("pipeline.announcements.runner.fetch_feed", side_effect=fake):
        return run_checker(feeds=list(feeds), conn=conn)


def rows(conn, sql, params=None):
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def test_repeated_runs_store_each_announcement_once(conn):
    first = run(conn, rss(AMR, DENGUE))
    second = run(conn, rss(AMR, DENGUE))
    assert first["metrics"]["new_items"] == 2
    assert second["metrics"]["new_items"] == 0
    assert second["metrics"]["duplicates_skipped"] == 2
    assert rows(conn, "select count(*) from bench.announcements") == [(2,)]
    stored = dict(rows(conn, "select title, relevance_category from bench.announcements"))
    assert stored == {"Antimicrobial resistance in the EU/EEA": "relevant", "Dengue in Europe": "unrelated"}
    # Both checks logged; the second inserted nothing and saw two known items.
    assert rows(conn, "select status, rows_parsed, rows_inserted, rows_unchanged from bench.import_runs"
                      " where source_id = 'ecdc_rss' order by run_id") == [
        ("succeeded", 2, 2, 0), ("succeeded", 2, 0, 2)]


def test_item_without_guid_is_deduplicated_by_canonical_url(conn):
    run(conn, rss(no_guid("https://www.ecdc.europa.eu/en/news/esbl-update?utm_source=rss")))
    run(conn, rss(no_guid("https://WWW.ecdc.europa.eu/en/news/esbl-update/")))
    assert rows(conn, "select guid, article_url from bench.announcements") == [
        ("https://www.ecdc.europa.eu/en/news/esbl-update", "https://www.ecdc.europa.eu/en/news/esbl-update")]


def test_rerun_keeps_first_detection_and_review_status(conn):
    run(conn, rss(AMR))
    with conn.cursor() as cur:
        cur.execute("update bench.announcements set status = 'reviewed',"
                    " first_detected_at = '2026-01-01', last_checked_at = '2026-01-01'")
    conn.commit()
    run(conn, rss(AMR))
    status, first, later = rows(conn, "select status, first_detected_at::date::text, last_checked_at > '2026-01-02'"
                                      " from bench.announcements")[0]
    assert (status, first, later) == ("reviewed", "2026-01-01", True)


def test_publication_time_is_stored_in_utc(conn):
    run(conn, rss(AMR))
    assert rows(conn, "select to_char(published_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI')"
                      " from bench.announcements") == [("2026-10-15 10:00",)]


def test_a_check_where_every_feed_fails_is_logged_as_failed(conn):
    summary = run(conn, None)
    assert summary["status"] == "failed"
    assert rows(conn, "select status, error like '%publications: Simulated outage%' from bench.import_runs"
                      " where source_id = 'ecdc_rss'") == [("failed", True)]
    assert rows(conn, "select count(*) from bench.announcements") == [(0,)]


def test_last_successful_check_is_visible_to_the_dashboard(conn):
    run(conn, None)
    assert rows(conn, "select last_import_at is null from api.external_sources"
                      " where source_id = 'ecdc_rss'") == [(True,)]
    run(conn, rss(AMR))
    assert rows(conn, "select last_import_at is not null from api.external_sources"
                      " where source_id = 'ecdc_rss'") == [(True,)]


def test_anon_reads_the_view_but_not_the_table(conn):
    run(conn, rss(AMR))
    with conn.cursor() as cur:
        cur.execute("set role anon")
        cur.execute("select title, attribution from api.announcements")
        title, attribution = cur.fetchone()
        assert title == "Antimicrobial resistance in the EU/EEA"
        assert "CC BY 4.0" in attribution
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            cur.execute("select * from bench.announcements")
    conn.rollback()

"""End-to-end against a throwaway Postgres: migrations -> seed -> replay -> aggregate -> api views.

Skipped unless TEST_DATABASE_URL points at a database this test may wipe, e.g.
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/amr_test
"""

import os
from pathlib import Path

import psycopg
import pytest

from pipeline import db, replay
from pipeline.run import execute
from tests.conftest import FIXTURES

URL = os.environ.get("TEST_DATABASE_URL")
ROOT = Path(__file__).resolve().parent.parent
pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL not set")


@pytest.fixture
def conn(monkeypatch):
    monkeypatch.setenv("AMR_DATA_DIR", str(FIXTURES))
    with psycopg.connect(URL, autocommit=True) as admin:
        admin.execute("drop schema if exists api, agg, bench, lab, staging, ref cascade")
        admin.execute((ROOT / "supabase" / "local_roles.sql").read_text())
        for f in sorted((ROOT / "supabase" / "migrations").glob("*.sql")):
            admin.execute(f.read_text())
    with db.connect(URL) as c:
        yield c


def _count(conn, sql):
    with conn.cursor() as cur:
        cur.execute(sql)
        return cur.fetchone()[0]


def test_seed_replay_aggregate(conn):
    steps = execute(conn, advance=1, reset_to=4, do_seed=True, run_id="t1")
    assert steps["seed"]["cultures"] == 12
    assert replay.get_cursor(conn) == 4
    assert _count(conn, "select count(*) from lab.cultures") == 9  # 10 in weeks 1-4, C8 rejected
    assert _count(conn, "select count(*) from lab.rejects") == 7
    assert _count(conn, "select count(*) from lab.susceptibility where is_intrinsic") == 2
    assert _count(conn, "select count(*) from agg.rates where end_week_idx = 4") > 0
    assert _count(conn, "select status from lab.pipeline_runs where run_id = 't1'") == "success"
    assert steps["feed"]["status"] in {"skipped", "rendered"}

    cip = _count(conn, "select n_4w from api.current_vs_baseline where organism = 'Escherichia coli' "
                       "and antibiotic_code = 'CIP' and specimen = 'urine' and scope_type = 'hospital'")
    assert cip == 1  # first-isolate de-duplication in the 4-week window

    execute(conn, advance=1, reset_to=None, do_seed=False, run_id="t2")
    assert replay.get_cursor(conn) == 5
    assert _count(conn, "select data_through from api.replay_status") == "2023-W44"


def test_advance_is_idempotent(conn):
    execute(conn, advance=1, reset_to=5, do_seed=True, run_id="t1")
    before = _count(conn, "select count(*) from lab.susceptibility")
    with conn.cursor() as cur:
        cur.execute("update lab.replay_state set cursor_week_idx = 4")
    conn.commit()
    replay.advance(conn, 1, "t2")
    assert _count(conn, "select count(*) from lab.susceptibility") == before
    assert replay.get_cursor(conn) == 5


def test_empty_week_stops_the_run(conn):
    execute(conn, advance=1, reset_to=6, do_seed=True, run_id="t1")
    with pytest.raises(replay.ValidationFailed):
        execute(conn, advance=1, reset_to=None, do_seed=False, run_id="t2")
    assert replay.get_cursor(conn) == 6
    assert _count(conn, "select status from lab.pipeline_runs where run_id = 't2'") == "failed"
    assert _count(conn, "select status from lab.dq_log where run_id = 't2' "
                        "and check_name = 'volume_vs_trailing_median'") == "fail"


def test_anon_reads_api_only(conn):
    execute(conn, advance=1, reset_to=4, do_seed=True, run_id="t1")
    with conn.cursor() as cur:
        cur.execute("set role anon")
        for view in ("replay_status", "rate_series", "current_vs_baseline", "antibiogram", "heatmap",
                     "ward_comparison", "benchmarks", "alerts", "alert_detail", "data_quality", "ref_organisms",
                     "ref_antibiotics", "ref_wards", "ref_intrinsic_resistance", "ref_phenotypes", "ref_weeks"):
            cur.execute(f"select * from api.{view} limit 1")
            cols = {d.name for d in cur.description}
            assert not cols & {"patient_id", "birth_year", "sample_date", "culture_id", "isolate_id"}, view
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            cur.execute("select * from lab.cultures limit 1")
    conn.rollback()


def test_migrations_can_be_reapplied_without_touching_data(conn):
    """migrate.yml re-applies every file when the schema was created outside this repo."""
    execute(conn, advance=1, reset_to=4, do_seed=True, run_id="t1")
    before = (_count(conn, "select count(*) from lab.cultures"), _count(conn, "select count(*) from agg.rates"),
              _count(conn, "select count(*) from ref.wards"))
    conn.commit()
    with psycopg.connect(URL, autocommit=True) as admin:
        for f in sorted((ROOT / "supabase" / "migrations").glob("*.sql")):
            admin.execute(f.read_text())
    after = (_count(conn, "select count(*) from lab.cultures"), _count(conn, "select count(*) from agg.rates"),
             _count(conn, "select count(*) from ref.wards"))
    assert after == before
    assert replay.get_cursor(conn) == 4

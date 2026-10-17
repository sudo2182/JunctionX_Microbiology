"""bench.observations against a throwaway Postgres (skipped unless TEST_DATABASE_URL is set; the test wipes it)."""

import dataclasses
import datetime as dt
import os
from pathlib import Path

import psycopg
import pytest

from pipeline import db
from pipeline.benchmarks import ecdc_atlas, finres, store, thl_nidr
from pipeline.benchmarks.model import COLUMNS, ValidationError

URL = os.environ.get("TEST_DATABASE_URL")
ROOT = Path(__file__).resolve().parent.parent.parent
FIX = Path(__file__).parent / "fixtures"
pytestmark = pytest.mark.skipif(not URL, reason="TEST_DATABASE_URL not set")
NOW = dt.datetime(2026, 10, 18, tzinfo=dt.UTC)


@pytest.fixture
def conn():
    with psycopg.connect(URL, autocommit=True) as admin:
        admin.execute("drop schema if exists api, agg, bench, lab, staging, ref cascade")
        admin.execute((ROOT / "supabase" / "local_roles.sql").read_text())
        for f in sorted((ROOT / "supabase" / "migrations").glob("*.sql")):
            admin.execute(f.read_text())
    with db.connect(URL) as c:
        store.sync_comparability(c)
        yield c


def scalar(conn, sql, params=None):
    with conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchone()[0]


def thl_batch():
    raw = (FIX / "thl_nidr_response.json").read_bytes()
    rows, skipped = thl_nidr.parse_response(raw, "https://example.org/q", NOW)
    return store.Batch("thl_nidr", "nidr_cases", rows, "https://example.org/q", NOW, skipped=skipped,
                       input_sha256=store.sha256_bytes(raw))


def test_finres_import_is_idempotent_and_detects_changes(conn):
    batch = finres.load("2024")
    first = store.import_batch(conn, batch)
    assert (first.inserted, first.updated, first.unchanged, first.skipped) == (575, 0, 0, 5)
    assert scalar(conn, "select count(*) from bench.observations where source_id = 'thl_finres'") == 575
    assert first.parsed == 585 and "10 identical duplicate rows merged" in first.notes   # K. pneumoniae blood ESBL
    both = scalar(conn, "select table_ref from bench.observations where organism = 'Klebsiella pneumoniae'"
                        " and phenotype = 'ESBL' and specimen = 'blood_csf' and period_start = '2024-01-01'")
    assert both == "Taulukko 20, p. 36; Taulukko 22, p. 38"

    again = store.import_batch(conn, finres.load("2024"))
    assert (again.inserted, again.updated, again.unchanged) == (0, 0, 575)

    changed = finres.load("2024")
    changed.rows[0] = dataclasses.replace(changed.rows[0], value=changed.rows[0].value + 1)
    third = store.import_batch(conn, changed)
    assert (third.inserted, third.updated, third.unchanged) == (0, 1, 574)
    assert scalar(conn, "select count(*) from bench.observations where source_id = 'thl_finres'") == 575

    ok = "select count(*) from bench.import_runs where status = 'succeeded' and input_sha256 is not null"
    assert scalar(conn, ok) == 3


def test_bad_batch_writes_nothing_and_is_logged_as_failed(conn):
    batch = thl_batch()
    batch.rows[3] = dataclasses.replace(batch.rows[3], specimen="saliva")
    with pytest.raises(ValidationError, match="unknown specimen"):
        store.import_batch(conn, batch)
    assert scalar(conn, "select count(*) from bench.observations") == 0
    status, error = None, None
    with conn.cursor() as cur:
        cur.execute("select status, error from bench.import_runs")
        status, error = cur.fetchone()
    assert status == "failed" and "unknown specimen" in error

    store.record_failure(conn, "thl_nidr", "nidr_cases", "source unreachable")
    assert scalar(conn, "select count(*) from bench.import_runs where status = 'failed'") == 2


def test_dry_run_diffs_without_writing(conn):
    res = store.import_batch(conn, thl_batch(), dry_run=True)
    assert res.inserted == 24 and res.run_id is None
    assert scalar(conn, "select count(*) from bench.observations") == 0
    assert scalar(conn, "select count(*) from bench.import_runs") == 0


def test_database_constraints_back_up_the_validation(conn):
    store.import_batch(conn, finres.load("2024"))
    with conn.cursor() as cur:
        with pytest.raises(psycopg.errors.CheckViolation):
            cur.execute("update bench.observations set value = 140 where indicator = 'pct_resistant'")
    conn.rollback()
    with conn.cursor() as cur:
        with pytest.raises(psycopg.errors.UniqueViolation):
            cols = ", ".join(COLUMNS)
            cur.execute(f"insert into bench.observations ({cols}) select {cols} from bench.observations limit 1")
    conn.rollback()


def test_api_views_show_only_comparable_series_with_provenance(conn):
    store.import_batch(conn, finres.load("2024"))
    store.import_batch(conn, thl_batch())
    with conn.cursor() as cur:
        cur.execute("select organism, antibiotic_code, specimen, pct_r, n_tested, year, source, comparison_kind,"
                    " attribution from api.benchmarks where organism = 'Escherichia coli' and year = 2024")
        rows = cur.fetchall()
        cur.execute("select antibiotic_code, specimen, sex, pct_r, n_tested from api.benchmarks_by_sex"
                    " where organism = 'Escherichia coli' and antibiotic_code = 'TMP' and year = 2024 order by sex")
        by_sex = cur.fetchall()
        cur.execute("select distinct indicator from api.external_context")
        context = {r[0] for r in cur.fetchall()}
    # blood E. coli series exist for all sexes; the urinary ones exist only per sex, so never in api.benchmarks
    assert {r[1] for r in rows} == {"TZP", "MEM", "CXM", "CRO", "CIP", "CAZ", "ESBL"}
    assert {r[2] for r in rows} == {"blood"}
    cip = next(r for r in rows if r[1] == "CIP")
    assert (float(cip[3]), cip[4], cip[6]) == (10.3, 3134, "Finres: Antimicrobial resistance of bacteria in Finland")
    assert "Finres" in cip[8] and cip[7] == "same_agent"
    assert [(a, b, c, float(d), e) for a, b, c, d, e in by_sex] == [
        ("TMP", "urine", "female", 17.6, 79749), ("TMP", "urine", "male", 18.4, 12129)]
    assert context == {"cases", "incidence_per_100k"}
    assert scalar(conn, "select count(*) from api.benchmarks_by_sex where sex = 'all'") == 0
    assert scalar(conn, "select count(*) from api.benchmarks where antibiotic_code = 'TMP' and specimen = 'urine'"
                  " and organism = 'Escherichia coli'") == 0


def test_newest_release_wins_in_the_view(conn):
    store.import_batch(conn, finres.load("2024"))
    newer = finres.load("2024")
    newer.rows = [dataclasses.replace(r, release="2025", value=r.value + 1)
                  for r in newer.rows if r.antimicrobial == "CIP" and r.specimen == "blood_csf"
                  and r.organism == "Escherichia coli"]
    store.import_batch(conn, newer)
    got = scalar(conn, "select pct_r from api.benchmarks where organism = 'Escherichia coli'"
                       " and antibiotic_code = 'CIP' and year = 2024")
    assert float(got) == 11.3


def test_group_level_ecdc_rows_are_stored_but_not_compared(conn):
    data = (FIX / "ecdc_atlas_format_fixture.csv").read_bytes()
    manifest = {"files": [{"name": "f.csv", "sha256": store.sha256_bytes(data), "retrieved_on": "2026-10-18",
                           "export_note": "format fixture"}]}
    batch = ecdc_atlas.load(data, "f.csv", manifest=manifest)
    store.import_batch(conn, batch)
    assert scalar(conn, "select count(*) from bench.observations where source_id = 'ecdc_ears_net'") == 3
    shown = scalar(conn, "select count(*) from api.benchmarks where source like 'EARS-Net%'")
    assert shown == 1      # only the MRSA phenotype share; the cephalosporin group is not the same measurement as CRO
    assert scalar(conn, "select antibiotic_code from api.benchmarks where source like 'EARS-Net%'") == "MRSA"


def test_comparability_sync_rejects_unknown_local_codes(conn, tmp_path):
    bad = tmp_path / "c.csv"
    header, first = (store.DATA_DIR / "comparability.csv").read_text().splitlines()[:2]
    broken = first.replace("Escherichia coli", "Escherichia nova").replace(",TZP,", ",ZZZ,")
    bad.write_text(header + "\n" + broken + "\n")
    with pytest.raises(ValidationError, match="unknown organism"):
        store.sync_comparability(conn, bad)


def test_comparability_sync_is_idempotent(conn):
    n = scalar(conn, "select count(*) from ref.benchmark_comparability")
    store.sync_comparability(conn)
    assert scalar(conn, "select count(*) from ref.benchmark_comparability") == n == 56


def test_anon_can_read_the_new_views_but_not_the_tables(conn):
    store.import_batch(conn, finres.load("2024"))
    with conn.cursor() as cur:
        cur.execute("set role anon")
        for view in ("benchmarks", "benchmarks_by_sex", "external_context", "external_sources"):
            cur.execute(f"select * from api.{view} limit 1")
        for table in ("bench.observations", "bench.import_runs", "bench.sources", "ref.benchmark_comparability"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                cur.execute(f"select * from {table} limit 1")
            conn.rollback()
            cur.execute("set role anon")
    conn.rollback()


def test_external_tables_do_not_reference_local_lab_data(conn):
    n = scalar(conn, """
        select count(*) from pg_constraint c
        join pg_class t on t.oid = c.conrelid join pg_namespace tn on tn.oid = t.relnamespace
        join pg_class r on r.oid = c.confrelid join pg_namespace rn on rn.oid = r.relnamespace
        where c.contype = 'f' and tn.nspname = 'bench' and rn.nspname in ('lab', 'agg', 'staging')""")
    assert n == 0

import csv
import datetime as dt
from pathlib import Path

import pytest

from pipeline.benchmarks import ecdc, glass, thl
from pipeline.benchmarks.__main__ import main
from pipeline.benchmarks.model import BenchRow, ValidationError, norm_group, validate, wilson
from pipeline.benchmarks.refresh import UPSERT_SQL, collect, run, summary_markdown

FIX = Path(__file__).parent / "fixtures"
RAW = FIX / "raw"
NOW = dt.datetime(2026, 10, 1, 6, 0, tzinfo=dt.UTC)
REPO = Path(__file__).resolve().parents[2]


def by_key(rows):
    return {(r.country, r.year, r.organism, r.antimicrobial_group, r.specimen_scope): r for r in rows}


def test_ecdc_pairs_percentage_with_denominator():
    rows = by_key(ecdc.parse((RAW / "ecdc_atlas_fixture.csv").read_text()))
    r = rows[("FI", 2023, "Escherichia coli", "third_generation_cephalosporins", "invasive")]
    assert (r.pct_r, r.n_tested, r.source) == (7.5, 4000, "ecdc")
    assert r.ci_low < 7.5 < r.ci_high
    eu = rows[("EU/EEA", 2023, "Escherichia coli", "third_generation_cephalosporins", "invasive")]
    assert eu.n_tested == 150000
    assert rows[("FI", 2023, "Staphylococcus aureus", "mrsa", "invasive")].pct_r == 2.0
    assert ("FI", 2022, "Pseudomonas aeruginosa", "piperacillin_tazobactam", "invasive") in rows


def test_ecdc_skips_other_countries_missing_values_and_denominator_only_rows():
    rows = by_key(ecdc.parse((RAW / "ecdc_atlas_fixture.csv").read_text()))
    assert not any(k[0] == "SE" for k in rows)
    assert ("FI", 2022, "Staphylococcus aureus", "mrsa", "invasive") not in rows  # "-" value
    assert ("FI", 2022, "Escherichia coli", "fluoroquinolones", "invasive") not in rows  # N only
    assert len(rows) == 5


def test_thl_tidy_csv():
    rows = by_key(thl.parse((RAW / "thl_finres_fixture.csv").read_text()))
    r = rows[("FI", 2023, "Escherichia coli", "trimethoprim", "urine")]
    assert r.pct_r == 17.0 and r.source == "thl" and r.source_url.startswith("https://thl.fi")
    assert rows[("FI", 2023, "Staphylococcus aureus", "mrsa", "all")].source_url == "https://example.org/finres"


def test_glass_aliases_and_counts_to_percent():
    rows = by_key(glass.parse((RAW / "glass_fixture.csv").read_text()))
    r = rows[("FI", 2022, "Escherichia coli", "third_generation_cephalosporins", "invasive")]
    assert r.pct_r == 7.0 and r.n_tested == 3800
    assert ("SE", 2022, "Escherichia coli", "third_generation_cephalosporins", "invasive") in rows
    assert ("FI", 2022, "Escherichia coli", "fluoroquinolones", "urine") in rows


def test_wilson_known_values():
    assert wilson(0, 30) == (0.0, 11.35)
    assert wilson(15, 30) == (33.15, 66.85)
    assert wilson(30, 30) == (88.65, 100.0)


@pytest.mark.parametrize(
    "change, msg",
    [
        ({"pct_r": 120.0}, "outside 0-100"),
        ({"year": 1850}, "implausible year"),
        ({"specimen_scope": "wound"}, "specimen_scope"),
        ({"n_tested": -1}, "negative"),
        ({"source": "random"}, "unknown source"),
    ],
)
def test_validation_rejects_bad_rows(change, msg):
    base = dict(
        source="thl",
        country="FI",
        year=2023,
        organism="Escherichia coli",
        antimicrobial_group="fluoroquinolones",
        specimen_scope="urine",
        n_tested=100,
        pct_r=8.0,
    )
    with pytest.raises(ValidationError, match=msg):
        validate([BenchRow(**{**base, **change})])


def test_validation_rejects_conflicting_duplicates_and_empty_input():
    a = BenchRow("thl", "FI", 2023, "Escherichia coli", "fluoroquinolones", "urine", 100, 8.0)
    b = BenchRow("thl", "FI", 2023, "Escherichia coli", "fluoroquinolones", "urine", 100, 9.0)
    with pytest.raises(ValidationError, match="duplicate"):
        validate([a, b])
    with pytest.raises(ValidationError, match="no rows"):
        validate([])


def test_bad_file_aborts_before_any_write(tmp_path):
    (tmp_path / "thl_bad.csv").write_text(
        "country,year,organism,antimicrobial_group,specimen_scope,n_tested,pct_r\n"
        "FI,2023,Escherichia coli,fluoroquinolones,urine,100,180\n"
    )
    conn = FakeConn()
    with pytest.raises(ValidationError):
        run(sources=["thl"], conn=conn, raw_dir=tmp_path, urls={}, now=NOW)
    assert conn.executed == [] and not conn.committed


def test_later_file_wins_and_failed_download_falls_back(tmp_path):
    hdr = "country,year,organism,antimicrobial_group,specimen_scope,n_tested,pct_r\n"
    (tmp_path / "thl_finres_2023.csv").write_text(hdr + "FI,2023,Escherichia coli,fluoroquinolones,urine,100,8\n")
    (tmp_path / "thl_finres_2024.csv").write_text(
        hdr + "FI,2023,Escherichia coli,fluoroquinolones,urine,100,9\n"
        "FI,2024,Escherichia coli,fluoroquinolones,urine,120,10\n"
    )
    res = collect("thl", tmp_path, url="http://127.0.0.1:9/nothing.csv")
    assert len(res.rows) == 2
    assert by_key(res.rows)[("FI", 2023, "Escherichia coli", "fluoroquinolones", "urine")].pct_r == 9.0
    assert any("download failed" in w for w in res.warnings)


def test_missing_source_is_skipped_not_fatal(tmp_path):
    res = collect("glass", tmp_path)
    assert res.rows == [] and "skipped" in res.warnings[0]


class FakeCursor:
    def __init__(self, conn):
        self.conn = conn

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self.conn.queries.append(sql)

    def fetchall(self):
        return self.conn.existing

    def executemany(self, sql, params):
        self.conn.executed.append((sql, list(params)))


class FakeConn:
    def __init__(self, existing=None):
        self.existing = existing or []
        self.queries, self.executed, self.committed = [], [], False

    def cursor(self):
        return FakeCursor(self)

    def commit(self):
        self.committed = True


def test_only_new_and_changed_rows_are_upserted():
    existing = [
        ("thl", "FI", 2023, "Escherichia coli", "fluoroquinolones", "urine", 50000, 8.0),  # unchanged
        ("thl", "FI", 2023, "Escherichia coli", "trimethoprim", "urine", 50000, 16.0),  # changed
    ]
    conn = FakeConn(existing)
    (res,) = run(sources=["thl"], conn=conn, raw_dir=RAW, urls={}, now=NOW)
    assert res.unchanged == 1 and len(res.changed) == 1 and len(res.new) == 3
    assert res.new_years == [2023]
    ((sql, params),) = conn.executed
    assert sql == UPSERT_SQL and "on conflict" in sql and len(params) == 4
    assert all(p[10] == NOW for p in params)  # retrieved_at
    assert conn.committed


def test_dry_run_writes_nothing():
    conn = FakeConn()
    run(sources=["ecdc", "thl", "glass"], conn=conn, raw_dir=RAW, urls={}, dry_run=True, now=NOW)
    assert conn.executed == [] and not conn.committed


def test_summary_table(tmp_path, monkeypatch):
    out = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(out))
    results = run(sources=["ecdc", "thl", "glass"], raw_dir=RAW, urls={}, now=NOW)
    md = out.read_text()
    assert "| ecdc | 1 | 5 | 2022–2023 | 5 |" in md
    assert md == summary_markdown(results, True)


def test_cli_without_database_validates_only(monkeypatch):
    monkeypatch.delenv("SUPABASE_DB_URL", raising=False)
    assert main(["--raw-dir", str(RAW), "--sources", "ecdc,thl,glass"]) == 0


def test_committed_raw_exports_parse_and_validate():
    for source in ("ecdc", "thl", "glass"):
        collect(source)  # raises on any invalid committed export


def test_mapping_uses_known_codes_and_groups():
    with open(REPO / "pipeline" / "benchmarks" / "mapping.csv") as fh:
        rows = list(csv.DictReader(fh))
    codes = {
        "AMP",
        "MEC",
        "TZP",
        "FOX",
        "CXM",
        "CRO",
        "CAZ",
        "MEM",
        "CIP",
        "TMP",
        "NIT",
        "VAN",
        "CLI",
        "ESBL",
        "MRSA",
        "VRE",
        "CPE",
    }
    keys = set()
    for r in rows:
        assert r["antibiotic_code"] in codes
        assert r["specimen_scope"] in ("invasive", "urine", "all")
        assert r["specimen"] in ("blood", "urine", "wound", "all")
        assert r["antimicrobial_group"] == norm_group(r["antimicrobial_group"])
        key = (r["organism"], r["antibiotic_code"], r["specimen"])
        assert key not in keys
        keys.add(key)
    # EARS-Net is invasive only: urine rows must never map to invasive benchmarks
    assert all(r["specimen_scope"] != "invasive" for r in rows if r["specimen"] == "urine")

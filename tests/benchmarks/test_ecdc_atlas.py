import datetime as dt
import json
from pathlib import Path

import pytest

from pipeline.benchmarks import ecdc_atlas
from pipeline.benchmarks.model import ValidationError, validate
from pipeline.benchmarks.store import sha256_bytes

DATA = (Path(__file__).parent / "fixtures" / "ecdc_atlas_format_fixture.csv").read_bytes()
TODAY = dt.date(2026, 10, 18)


def test_pairs_percentage_with_denominator_and_filters_scope():
    rows, skipped = ecdc_atlas.parse(DATA, "f.csv", "2026-10-18", today=TODAY)
    validate(rows)
    by = {(r.geo_code, r.organism, r.antimicrobial, r.phenotype): r for r in rows}
    fi = by[("FI", "Escherichia coli", "third_generation_cephalosporins", "")]
    assert (fi.value, fi.denominator, fi.specimen, fi.geo_level) == (11.1, 111, "blood_csf", "country")
    assert fi.antimicrobial_src == "Third-generation cephalosporins" and fi.release == "2026-10-18"
    assert by[("EU/EEA", "Escherichia coli", "third_generation_cephalosporins", "")].geo_level == "eu_eea"
    mrsa = by[("FI", "Staphylococcus aureus", "", "MRSA")]
    assert mrsa.value == 6.6 and mrsa.denominator == 66
    # Sweden, the 'S' indicator, the 2030 year, a blank value and a denominator without a percentage are not rows
    assert len(rows) == 3 and skipped >= 5
    assert ("SE", "Escherichia coli", "third_generation_cephalosporins", "") not in by
    assert not any(r.antimicrobial == "ceftazidime" or r.antimicrobial == "carbapenems" for r in rows)


def test_missing_columns_stop_with_the_headers_found():
    with pytest.raises(ValidationError, match="missing columns"):
        ecdc_atlas.parse(b"Country,Year,Value\nFI,2019,1\n", "f.csv", "2026-10-18", today=TODAY)


def test_unrecognised_indicators_stop_with_a_summary():
    bad = DATA.replace(b"R - resistant isolates, percentage", b"Resistance share")
    with pytest.raises(ValidationError, match="no resistant-percentage rows recognised"):
        ecdc_atlas.parse(bad, "f.csv", "2026-10-18", today=TODAY)


def test_non_annual_time_is_refused():
    bad = DATA.replace(b",2019,FI,Finland,11.1", b",2019-Q1,FI,Finland,11.1")
    with pytest.raises(ValidationError, match="not a calendar year"):
        ecdc_atlas.parse(bad, "f.csv", "2026-10-18", today=TODAY)


def test_manifest_gates_the_import(tmp_path):
    manifest_path = tmp_path / "m.json"
    manifest_path.write_text('{"files": []}')
    with pytest.raises(ValidationError, match="not in"):
        ecdc_atlas.check_manifest("f.csv", sha256_bytes(DATA), json.loads(manifest_path.read_text()))
    entry = ecdc_atlas.register("f.csv", DATA, "2026-10-18", "FI + EU/EEA, all years", None, path=manifest_path)
    assert entry["sha256"] == sha256_bytes(DATA) and entry["storage_path"] == "benchmark-raw/f.csv"
    manifest = ecdc_atlas.read_manifest(manifest_path)
    assert ecdc_atlas.check_manifest("f.csv", sha256_bytes(DATA), manifest)["retrieved_on"] == "2026-10-18"
    with pytest.raises(ValidationError, match="does not match"):
        ecdc_atlas.check_manifest("f.csv", sha256_bytes(DATA + b"x"), manifest)
    with pytest.raises(ValidationError, match="already in the manifest"):
        ecdc_atlas.register("f.csv", DATA, "2026-10-18", "again", None, path=manifest_path)


def test_load_refuses_unregistered_bytes():
    with pytest.raises(ValidationError, match="not in"):
        ecdc_atlas.load(DATA, "f.csv", manifest={"files": []})

import datetime as dt
from pathlib import Path

import pytest

from pipeline.benchmarks import thl_nidr
from pipeline.benchmarks.model import ValidationError, validate

FIX = Path(__file__).parent / "fixtures"
NOW = dt.datetime(2026, 10, 18, tzinfo=dt.UTC)


@pytest.fixture(scope="module")
def dims():
    return thl_nidr.parse_dimensions((FIX / "thl_nidr_dimensions.jsonp").read_bytes())


@pytest.fixture(scope="module")
def parsed():
    return thl_nidr.parse_response((FIX / "thl_nidr_response.json").read_bytes(), "https://example.org/q", NOW)


def test_dimensions_are_read_from_jsonp(dims):
    assert dims["measure"] == {"Cases": 877837, "Incidence": 931297, "Population": 433796}
    assert dims["wscmunicipality2022"]["Southwest Finland wellbeing services county"] == 878211
    assert dims["nidrreportgroup"]["S. aureus, blood/liquor MRSA"] == 878105


def test_only_complete_years_are_offered(dims):
    assert thl_nidr.available_years(dims, 2015, today=dt.date(2026, 10, 18)) == [2023, 2024, 2025]
    assert thl_nidr.available_years(dims, 2024, today=dt.date(2026, 10, 18)) == [2024, 2025]


def test_url_uses_category_ids_from_the_dimensions_file(dims):
    url = thl_nidr.build_url(dims, [2024], [thl_nidr.NATIONAL])
    assert url.startswith(thl_nidr.BASE + ".json?row=nidrreportgroup-")
    assert "878105" in url and "&column=measure-877837.931297.433796." in url


def test_unknown_category_fails_loudly(dims):
    with pytest.raises(ValidationError, match="register layout changed"):
        thl_nidr.build_url(dims, [1850], [thl_nidr.NATIONAL])


def test_real_response_becomes_cases_and_incidence_rows(parsed):
    rows, skipped = parsed
    assert skipped == 0 and len(rows) == 24            # 3 groups x 2 years x 2 areas x (cases + incidence)
    validate(rows)
    by = {(r.organism, r.phenotype, r.specimen, r.geo_code, r.period_start.year, r.indicator): r for r in rows}
    mrsa = by[("Staphylococcus aureus", "MRSA", "blood_csf", "FI", 2024, "cases")]
    assert mrsa.value == 102 and mrsa.unit == "cases" and mrsa.denominator is None
    inc = by[("Staphylococcus aureus", "MRSA", "blood_csf", "FI", 2024, "incidence_per_100k")]
    assert inc.value == 1.8 and inc.numerator == 102 and inc.denominator == 5635971
    assert inc.unit == "per 100,000 population"
    county = by[("Staphylococcus aureus", "MRSA", "blood_csf", "wsc:05", 2023, "cases")]
    assert county.value == 7 and county.geo_level == "county"
    assert all(r.indicator in ("cases", "incidence_per_100k") for r in rows)   # never a resistance percentage
    assert {r.specimen for r in rows} == {"blood_csf", "carriage"}


def test_cells_without_a_value_are_skipped_not_zero():
    import json
    raw = json.loads((FIX / "thl_nidr_response.json").read_bytes())
    raw["dataset"]["value"].pop("0")          # first cell: MRSA blood, 2023, Finland, cases
    raw["dataset"]["value"]["1"] = "."        # and a non-numeric marker
    rows, skipped = thl_nidr.parse_response(json.dumps(raw).encode(), "u", NOW)
    assert skipped == 2 and len(rows) == 22


def test_unexpected_reporting_group_is_refused():
    import json
    raw = json.loads((FIX / "thl_nidr_response.json").read_bytes())
    cat = raw["dataset"]["dimension"]["nidrreportgroup"]["category"]
    first = next(iter(cat["label"]))
    cat["label"][first] = "Tuberculosis, total"
    with pytest.raises(ValidationError, match="unexpected reporting groups"):
        thl_nidr.parse_response(json.dumps(raw).encode(), "u", NOW)

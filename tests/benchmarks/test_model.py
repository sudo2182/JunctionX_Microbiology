import datetime as dt

import pytest

from pipeline.benchmarks.model import Observation, ValidationError, validate


def obs(**kw) -> Observation:
    base = dict(
        source_id="thl_finres", dataset="finres", release="2024", source_url="https://example.org",
        period_start=dt.date(2023, 1, 1), period_end=dt.date(2023, 12, 31), geo_level="country", geo_code="FI",
        geo_name="Finland", organism="Escherichia coli", organism_src="Escherichia coli", specimen="urine",
        indicator="pct_resistant", value=10.0, unit="%", antimicrobial="CIP", antimicrobial_src="CIP",
    )
    return Observation(**{**base, **kw})


def test_good_batch_passes():
    validate([obs(), obs(antimicrobial="TMP", antimicrobial_src="TMP", denominator=100, numerator=10)])


@pytest.mark.parametrize("kw, text", [
    ({"value": 101.0}, "above 100"),
    ({"value": -1.0}, "invalid value"),
    ({"value": float("nan")}, "invalid value"),
    ({"specimen": "saliva"}, "unknown specimen"),
    ({"source_id": "who"}, "unknown source_id"),
    ({"numerator": 5, "denominator": 3}, "exceeds denominator"),
    ({"denominator": -2}, "negative denominator"),
    ({"value_status": "derived"}, "derived value without a derivation"),
    ({"period_end": dt.date(2022, 12, 31)}, "ends before it starts"),
    ({"period_start": dt.date(2090, 1, 1), "period_end": dt.date(2090, 12, 31)}, "implausible year"),
    ({"period_start": dt.date.today().replace(month=1, day=1), "period_end": dt.date.today()}, "not finished"),
])
def test_bad_rows_are_rejected(kw, text):
    with pytest.raises(ValidationError, match=text):
        validate([obs(**kw)])


def test_empty_batch_is_rejected():
    with pytest.raises(ValidationError, match="no observations"):
        validate([])


def test_conflicting_duplicate_keys_are_rejected_but_identical_ones_are_not():
    validate([obs(), obs()])
    with pytest.raises(ValidationError, match="duplicate key"):
        validate([obs(value=10.0), obs(value=11.0)])


def test_all_problems_are_reported_together():
    with pytest.raises(ValidationError) as e:
        validate([obs(value=150.0), obs(specimen="saliva", antimicrobial="TMP")])
    assert "above 100" in str(e.value) and "unknown specimen" in str(e.value)

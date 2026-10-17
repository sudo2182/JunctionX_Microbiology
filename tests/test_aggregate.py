import pandas as pd
import pytest

from pipeline.aggregate import compute_rates, dedup_summary, first_isolates
from pipeline.clean import clean_batch
from pipeline.config import data_dir
from tests.conftest import lab_isolates, read_raw


def _rate(rates, organism, code, specimen="urine", window=4, scope=("hospital", "ALL")):
    r = rates[(rates.organism == organism) & (rates.antibiotic_code == code) & (rates.specimen == specimen)
              & (rates.window_weeks == window) & (rates.scope_type == scope[0]) & (rates.scope_value == scope[1])]
    assert len(r) == 1, r
    return r.iloc[0]


def test_repeat_isolate_in_one_window_counts_once(batch):
    rates = compute_rates(lab_isolates(batch), batch.susceptibility, end_week_idx=4)
    cip = _rate(rates, "Escherichia coli", "CIP")
    # P1: C1 (R) and repeat C2 (S) in weeks 1-4 -> only C1 counts. C7-1 is blood, not urine.
    assert (cip.n_tested, cip.n_resistant) == (1, 1)
    tmp = _rate(rates, "Escherichia coli", "TMP")
    assert (tmp.n_tested, tmp.n_resistant) == (1, 0)  # C2's TMP R is a repeat


def test_same_patient_in_two_windows_counts_in_each(batch):
    iso = lab_isolates(batch)
    first = _rate(compute_rates(iso, batch.susceptibility, end_week_idx=4), "Escherichia coli", "CIP")
    second = _rate(compute_rates(iso, batch.susceptibility, end_week_idx=8), "Escherichia coli", "CIP")
    assert first.n_tested == 1 and second.n_tested == 1  # C1 in weeks 1-4, C3 in weeks 5-8
    assert second.n_resistant == 0


def test_intrinsic_and_non_reportable_rows_never_count(batch):
    rates = compute_rates(lab_isolates(batch), batch.susceptibility, end_week_idx=4)
    keys = set(zip(rates.organism, rates.antibiotic_code))
    assert ("Klebsiella pneumoniae", "AMP") not in keys
    assert ("Proteus mirabilis", "NIT") not in keys
    assert ("Staphylococcus aureus", "TMP") not in keys
    assert ("Klebsiella pneumoniae", "CIP") in keys


def test_phenotype_share_uses_first_isolates(batch):
    rates = compute_rates(lab_isolates(batch), batch.susceptibility, end_week_idx=4)
    esbl = _rate(rates, "Escherichia coli", "ESBL")
    assert (esbl.n_tested, esbl.n_resistant) == (1, 0)  # C2 (ESBL) is P1's repeat
    mrsa = _rate(rates, "Staphylococcus aureus", "MRSA", specimen="wound")
    assert (mrsa.n_tested, mrsa.n_resistant) == (1, 1)


def test_scopes_and_specimen_all(batch):
    rates = compute_rates(lab_isolates(batch), batch.susceptibility, end_week_idx=4)
    assert set(rates.scope_type) == {"hospital", "ward", "setting", "onset"}
    ward = _rate(rates, "Escherichia coli", "CIP", specimen="blood", scope=("ward", "ICU"))
    assert (ward.n_tested, ward.n_resistant) == (1, 1)
    # specimen 'all' de-duplicates across specimens: P1 urine + P3 blood E. coli
    allspec = _rate(rates, "Escherichia coli", "CIP", specimen="all")
    assert allspec.n_tested == 2
    assert not (rates[rates.scope_type != "hospital"].specimen == "all").any()
    assert not (rates[rates.window_weeks == 1].scope_type != "hospital").any()


def test_thirty_isolate_gate_and_wilson():
    n = 30
    iso = pd.DataFrame({
        "isolate_id": [f"I{i}" for i in range(n)], "patient_id": [f"P{i}" for i in range(n)],
        "organism": "Escherichia coli", "specimen": "urine", "sample_date": pd.Timestamp("2025-01-06"),
        "week_idx": 67, "ward_code": "ED", "setting": "ed", "onset": "outpatient",
        "esbl": False, "mrsa": False, "vre": False, "cpe": False,
    })
    ast = pd.DataFrame({"isolate_id": iso.isolate_id, "antibiotic_code": "CIP",
                        "result": ["R"] * 15 + ["S"] * 15, "is_intrinsic": False, "reportable": True})
    rates = compute_rates(iso, ast, 67, windows=(4,))
    hosp = _rate(rates, "Escherichia coli", "CIP")
    assert hosp.reportable and hosp.pct_r == 50.0
    assert (hosp.wilson_low, hosp.wilson_high) == (pytest.approx(33.15, abs=0.01), pytest.approx(66.85, abs=0.01))
    small = compute_rates(iso.iloc[:29], ast.iloc[:29], 67, windows=(4,))
    assert not _rate(small, "Escherichia coli", "CIP").reportable


def test_first_isolate_tie_break_is_deterministic():
    df = pd.DataFrame({"isolate_id": ["B", "A"], "patient_id": "P", "organism": "x", "specimen": "urine",
                       "sample_date": pd.Timestamp("2025-01-01")})
    assert first_isolates(df).isolate_id.tolist() == ["A"]


def test_dedup_summary(batch):
    s = dedup_summary(lab_isolates(batch), 4)
    assert s["removed"] == 1  # C2-1


def _full_dataset():
    try:
        return data_dir()
    except FileNotFoundError:
        return None


@pytest.mark.skipif(_full_dataset() is None, reason="full synthetic dataset not available")
def test_regression_matches_data_profile():
    """Hospital-wide first-isolate E. coli urine over 3 years (three 52-week windows) = profile values."""
    batch = clean_batch(read_raw(_full_dataset()))
    iso = lab_isolates(batch)
    parts = [compute_rates(iso, batch.susceptibility, w, windows=(52,)) for w in (52, 104, 156)]
    r = pd.concat(parts)
    r = r[(r.scope_type == "hospital") & (r.organism == "Escherichia coli") & (r.specimen == "urine")]
    tot = r.groupby("antibiotic_code")[["n_tested", "n_resistant"]].sum()
    pct = (100 * tot.n_resistant / tot.n_tested).round(1)
    assert tot.loc["CIP", "n_tested"] == 7657
    assert pct["CIP"] == 8.4 and pct["TMP"] == 18.4 and pct["NIT"] == 0.4 and pct["MEC"] == 2.7
    assert int(batch.susceptibility.is_intrinsic.sum()) == 874 + 621 + 2384 + 1258

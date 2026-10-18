import pandas as pd

from pipeline.clean import age_band, classify_onset, clean_batch, validate


def _ast(batch, isolate_id, code):
    s = batch.susceptibility
    return s[(s.isolate_id == isolate_id) & (s.antibiotic_code == code)].iloc[0]


def test_onset_day_edges():
    ward_type = pd.Series(["in", "in", "in", "out", "in"])
    sample = pd.Series(["2023-10-03", "2023-10-04", "2023-10-05", "2023-10-05", "2023-10-05"])
    admit = pd.Series(["2023-10-03", "2023-10-03", "2023-10-03", None, None])
    assert list(classify_onset(ward_type, sample, admit)) == [
        "community",  # day 1
        "community",  # day 2
        "hospital",   # day 3
        "outpatient",
        "unknown",    # inpatient without admission date
    ]


def test_onset_and_setting_on_fixture(batch):
    c = batch.cultures.set_index("culture_id")
    assert c.loc["C4", "onset"] == "community" and c.loc["C5", "onset"] == "hospital"
    assert c.loc["C7", "onset"] == "community"
    assert c.loc["C1", "onset"] == "outpatient" and c.loc["C6", "onset"] == "outpatient"
    assert c.loc["C1", "setting"] == "primary_care"
    assert c.loc["C6", "setting"] == "ed"
    assert c.loc["C4", "setting"] == "inpatient"
    assert c.loc["C1", "sex"] == "F" and c.loc["C4", "sex"] == "M"


def test_intrinsic_resistance_flagged(batch):
    assert bool(_ast(batch, "C4-1", "AMP").is_intrinsic)  # K. pneumoniae - ampicillin
    assert bool(_ast(batch, "C6-1", "NIT").is_intrinsic)  # P. mirabilis - nitrofurantoin
    assert not bool(_ast(batch, "C1-1", "AMP").is_intrinsic)  # E. coli - ampicillin is real
    assert int(batch.susceptibility.is_intrinsic.sum()) == 2


def test_urine_only_agent_on_wound_not_reportable(batch):
    assert not bool(_ast(batch, "C5-1", "TMP").reportable)
    assert bool(_ast(batch, "C1-1", "TMP").reportable)
    assert bool(_ast(batch, "C5-1", "FOX").reportable)


def test_rejects_are_counted_not_dropped(batch):
    reasons = set(zip(batch.rejects.table_name, batch.rejects.row_key, batch.rejects.reason))
    assert ("cultures", "C8", "unknown ward_code") in reasons
    assert ("isolates", "C8-1", "culture missing or rejected") in reasons
    assert ("isolates", "C7-2", "unknown organism") in reasons
    assert ("susceptibility", "C7-2:CIP", "isolate missing or rejected") in reasons
    assert ("susceptibility", "C7-1:ZZZ", "unknown antibiotic_code") in reasons
    assert ("susceptibility", "C6-1:AMP", "result not S/R") in reasons
    assert "C8" not in set(batch.cultures.culture_id)
    assert "C7-2" not in set(batch.isolates.isolate_id)
    assert set(batch.susceptibility.result) <= {"S", "R"}


def test_dq_counts(batch):
    dq = {(d["week_idx"], d["check_name"]): d for d in batch.dq}
    assert dq[(1, "cultures_released")]["value"] == 5
    assert dq[(1, "ast_intrinsic_excluded")]["value"] == 1
    assert dq[(1, "ast_not_reportable")]["value"] == 1
    assert dq[(2, "rows_rejected")]["status"] == "warn"


def test_age_band():
    assert list(age_band(pd.Series([0, 17, 18, 64, 65, 79, 80, 101]))) == [
        "0-17", "0-17", "18-64", "18-64", "65-79", "65-79", "80+", "80+"
    ]


def test_validate_passes_on_fixture(batch):
    checks = validate(batch, [1, 2, 3, 4, 5, 6])
    assert not [c for c in checks if c["status"] == "fail"]


def test_validate_fails_on_empty_week_and_future_dates(raw):
    batch = clean_batch(raw)
    checks = {(c["week_idx"], c["check_name"]): c for c in validate(batch, [6, 7])}
    assert checks[(7, "volume_vs_trailing_median")]["status"] == "fail"

    raw.cultures.loc[raw.cultures.culture_id == "C1", "sample_date"] = "2023-10-20"  # labelled week 1
    checks = validate(clean_batch(raw), [1])
    assert any(c["check_name"] == "sample_date_after_week_end" and c["status"] == "fail" for c in checks)


def test_validate_warns_on_low_volume(batch):
    history = pd.Series({w: 100 for w in range(1, 1 + 8)})
    shifted = batch.cultures.assign(week_idx=batch.cultures.week_idx + 8)
    batch.cultures = shifted
    checks = validate(batch, [9], history)
    vol = next(c for c in checks if c["check_name"] == "volume_vs_trailing_median")
    assert vol["status"] == "warn"

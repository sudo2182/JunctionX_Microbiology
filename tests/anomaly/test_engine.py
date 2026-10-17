from pipeline.anomaly import Engine, build_episodes, week_idx_of, week_label
from pipeline.anomaly.data import derive_onset
from pipeline.anomaly.engine import Window

from .fixtures import Lab, steady_ecoli

T = 60  # current window 57..60, baseline 5..56


def test_week_index_round_trip():
    assert week_idx_of(2023, 40) == 1
    assert week_idx_of(2025, 23) == 88
    assert week_idx_of(2026, 10) == 127
    assert week_label(156) == "2026-W39"
    assert week_label(85) == "2025-W20"


def test_onset_day_edges():
    import pandas as pd

    adm = pd.Series(pd.to_datetime(["2025-01-01"] * 3 + [None]))
    sample = pd.Series(pd.to_datetime(["2025-01-01", "2025-01-02", "2025-01-03", "2025-01-03"]))
    ward_type = pd.Series(["in", "in", "in", "out"])
    assert derive_onset(ward_type, sample, adm).tolist() == ["community", "community", "hospital", "outpatient"]


def test_first_isolate_counts_a_patient_once_per_window():
    lab = Lab()
    p = lab.patient()
    for w in (57, 58, 59):
        lab.add(w, patient=p, CIP=True)
    lab.add(57, patient=p, specimen="blood", CIP=True)  # other specimen counts separately
    e = Engine(*lab.frames())
    first = e.first_isolates(Window(57, 60), "hospital")
    assert len(first) == 2
    assert len(e.first_isolates(Window(57, 57), "hospital")) == 2
    assert len(e.first_isolates(Window(58, 58), "hospital")) == 1


def test_rate_alert_fires_for_a_ward_rise_and_explains_itself():
    lab = Lab()
    steady_ecoli(lab, range(5, 57), per_week=10, resistant_every=20)  # 5% CIP R baseline
    k = 0
    for w in range(57, T + 1):
        for _ in range(10):
            k += 1
            lab.add(w, CIP=(k % 5 < 2), ESBL=False)  # 40% in the current window
    alerts = Engine(*lab.frames()).detect_week(T)
    hit = [a for a in alerts if a.type == "rate" and a.marker == "CIP" and a.scope_value == "URO"]
    assert hit, [a.key for a in alerts]
    a = hit[0]
    ev = a.evidence
    assert ev["current"]["n"] == 40 and ev["current"]["x"] == 16
    assert ev["baseline"]["n"] == 520 and ev["baseline"]["x"] == 26
    assert ev["test"]["q"] < 0.05
    assert ev["distinct_patients"] == 16
    assert ev["breakdown"]["onset"] == {"hospital": 16}
    assert "40.0% (16 of 40" in a.sentence and "5.0% (26 of 520)" in a.sentence
    assert a.confidence in ("medium", "high")


def test_no_alert_when_rate_is_stable():
    lab = Lab()
    steady_ecoli(lab, range(5, T + 1), per_week=10, resistant_every=20)
    alerts = Engine(*lab.frames()).detect_week(T)
    assert [a for a in alerts if a.type == "rate"] == []


def test_gate_widens_window_then_gives_up_below_30():
    lab = Lab()
    t = 80  # a 13-week window needs baseline weeks 16..67
    steady_ecoli(lab, range(1, t + 1), per_week=3, resistant_every=50, ward="ICU")  # 12 per 4 wk, 24 per 8, 39 per 13
    e = Engine(*lab.frames())
    tests = e._rate_candidates(t)
    icu = [t for t in tests if t["scope_value"] == "ICU" and t["marker"] == "CIP"]
    assert [t["cur_w"].weeks for t in icu] == [13]

    lab2 = Lab()
    steady_ecoli(lab2, range(1, t + 1), per_week=1, resistant_every=50, ward="ICU")  # 13 per 13 wk
    tests = Engine(*lab2.frames())._rate_candidates(t)
    assert not [t for t in tests if t["scope_value"] == "ICU"]


def test_weekly_test_for_ecoli_urine_hospital():
    lab = Lab()
    steady_ecoli(lab, range(5, T + 1), per_week=35, resistant_every=20)
    tests = Engine(*lab.frames())._rate_candidates(T)
    assert any(t["cur_w"].weeks == 1 and t["scope_type"] == "hospital" for t in tests)


def test_count_alert_for_mrsa_cluster():
    lab = Lab()
    for w in range(5, 57, 13):  # 4 MRSA patients in the baseline year
        lab.add(w, organism="Staphylococcus aureus", specimen="wound", ward="ICU", MRSA=True)
    for w in (57, 58, 58, 59, 60, 60):
        lab.add(w, organism="Staphylococcus aureus", specimen="wound", ward="ICU", MRSA=True)
    lab.add(60, organism="Staphylococcus aureus", specimen="blood", ward="ICU", MRSA=True)
    alerts = Engine(*lab.frames()).detect_week(T)
    hit = [a for a in alerts if a.type == "count" and a.organism == "MRSA" and a.scope_value == "ICU"]
    assert hit
    a = hit[0]
    assert a.evidence["current"]["k"] == 7
    assert a.evidence["expected"]["count"] == 0.5  # 4 / 52 * 4 = 0.31, floored at 0.5
    assert a.to_dict()["severity"] == {"band": "critical", "points": a.severity_points}
    assert a.severity == "critical"  # priority + blood + >=3x + hospital onset + >=5 patients
    assert a.confidence == "high"


def test_sentinel_fires_once_per_new_patient():
    lab = Lab()
    p = lab.patient()
    lab.add(58, patient=p, organism="Klebsiella pneumoniae", ward="MED-A", CPE=True, MEM=True)
    lab.add(59, patient=p, organism="Klebsiella pneumoniae", ward="MED-A", CPE=True, MEM=True)
    e = Engine(*lab.frames())
    first = e.detect_week(58)
    sentinels = [a for a in first if a.type == "sentinel"]
    assert [a.organism for a in sentinels] == ["CPE"]  # not also reported as carbapenem-R
    assert sentinels[0].severity in ("high", "critical")
    assert [a for a in e.detect_week(59) if a.type == "sentinel"] == []


def test_intrinsic_and_off_label_markers_are_dropped_by_loader_cleaning():
    from pipeline.anomaly.data import clean_markers

    lab = Lab()
    a = lab.add(57, organism="Klebsiella pneumoniae", AMP=True, CIP=False)
    b = lab.add(57, organism="Escherichia coli", specimen="blood", TMP=True, CRO=False)
    iso, mk = lab.frames()
    kept = clean_markers(mk, iso)
    assert set(map(tuple, kept[["isolate_id", "marker"]].values)) == {(a, "CIP"), (b, "CRO")}


def test_episodes_group_consecutive_weeks_and_resolve():
    lab = Lab()
    for w in (57, 58, 59, 60, 61, 62):
        for _ in range(2):
            lab.add(w, organism="Staphylococcus aureus", specimen="wound", ward="ICU", MRSA=True)
    e = Engine(*lab.frames())
    alerts = [a for t in range(58, 70) for a in e.detect_week(t)]
    eps = [ep for ep in build_episodes(alerts, through_week=69) if "count|MRSA|MRSA|all|ward|ICU" == ep.key]
    assert len(eps) == 1
    ep = eps[0]
    assert ep.opened_week <= 59
    assert ep.status == "resolved"
    assert ep.resolved_week == ep.last_fired_week + 2

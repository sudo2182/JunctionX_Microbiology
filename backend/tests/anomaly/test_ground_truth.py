"""BUILD_PLAN §7.7: the engine must catch the outbreaks planted in the synthetic dataset.

Needs the synthetic LIS export (cultures.csv, isolates.csv, susceptibility.csv). It looks in
$AMR_DATA_DIR, then data/raw/, data/tyks/ and /mnt/user-data/uploads, and skips if none exist.
Set AMR_SLOW=1 to also replay weeks 56-156 and check the false-alarm burden (~2 minutes).
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from pipeline.anomaly import Engine, build_episodes, load_csv_dir

ROOT = Path(__file__).resolve().parents[3]  # repository root
CANDIDATES = [os.environ.get("AMR_DATA_DIR"), ROOT / "data/raw", ROOT / "data/tyks", "/mnt/user-data/uploads"]
URO_ESBL = range(88, 98)  # 2025-W23..W32: outbreak W23-W29 plus the weeks it should resolve in
ICU_MRSA = range(127, 131)  # 2026-W10..W13


def _data_dir() -> Path | None:
    for c in CANDIDATES:
        if c and (Path(c) / "susceptibility.csv").exists():
            return Path(c)
    return None


pytestmark = pytest.mark.skipif(_data_dir() is None, reason="synthetic dataset not available")


@pytest.fixture(scope="module")
def engine() -> Engine:
    return Engine(*load_csv_dir(_data_dir()))


@pytest.fixture(scope="module")
def uro_alerts(engine):
    return {t: engine.detect_week(t) for t in URO_ESBL}


@pytest.fixture(scope="module")
def icu_alerts(engine):
    return {t: engine.detect_week(t) for t in ICU_MRSA}


def _serious(a) -> bool:
    return a.severity in ("high", "critical")


def test_urology_esbl_outbreak_is_high_or_critical_by_2025_w26(uro_alerts):
    def uro_esbl(a):
        return a.scope_value == "URO" and a.marker == "ESBL" and _serious(a)

    first = min(t for t, alerts in uro_alerts.items() if any(uro_esbl(a) for a in alerts))
    assert first <= 91  # 2025-W26
    rate = [a for t in range(88, 92) for a in uro_alerts[t] if uro_esbl(a) and a.type == "rate"]
    assert rate, "expected the ESBL share rate signal, not only the count"
    top = max(rate, key=lambda a: a.evidence["current"]["pct"])
    assert top.evidence["current"]["pct"] >= 30
    assert top.evidence["baseline"]["pct"] <= 6
    assert top.evidence["breakdown"]["onset"].get("hospital", 0) > 0
    assert "Urology" in top.sentence


def test_urology_outbreak_lifts_hospital_wide_ciprofloxacin(uro_alerts):
    hits = [
        a
        for t in range(88, 95)
        for a in uro_alerts[t]
        if a.type == "rate"
        and a.scope_value == "ALL"
        and a.organism == "Escherichia coli"
        and a.specimen == "urine"
        and a.marker == "CIP"
    ]
    assert hits


def test_urology_episode_resolves_after_the_outbreak(uro_alerts):
    alerts = [a for t in URO_ESBL for a in uro_alerts[t]]
    episodes = [e for e in build_episodes(alerts, through_week=97) if e.key.endswith("|ward|URO") and "ESBL" in e.key]
    assert episodes
    assert all(e.last_fired_week <= 95 for e in episodes)
    assert all(e.status == "resolved" for e in episodes)


def test_icu_mrsa_cluster_is_high_or_critical_by_2026_w12(icu_alerts):
    def icu_mrsa(a):
        return a.scope_value == "ICU" and a.marker == "MRSA" and a.type == "count" and _serious(a)

    first = min(t for t, alerts in icu_alerts.items() if any(icu_mrsa(a) for a in alerts))
    assert first <= 129  # 2026-W12
    blood = [a for t in ICU_MRSA for a in icu_alerts[t] if a.type == "sentinel" and a.organism == "Blood MRSA"]
    assert blood and all(a.scope_value == "ICU" for a in blood)
    # the outbreak is the top-ranked alert in the hospital the week it peaks
    assert icu_alerts[130][0].marker == "MRSA"


def test_trimethoprim_drift_is_low_severity(engine):
    drift = [a for a in engine.drift_alerts(156) if a.marker == "TMP" and a.organism == "Escherichia coli"]
    assert drift
    from pipeline.anomaly.scoring import score

    score(drift[0])
    assert drift[0].severity == "low"


@pytest.mark.skipif(not os.environ.get("AMR_SLOW"), reason="set AMR_SLOW=1 for the full replay")
def test_false_alarm_burden(engine):
    alerts = engine.detect_range(56)
    outbreak_weeks = set(range(87, 98)) | set(range(126, 135))
    quiet = [a for a in alerts if a.week_idx not in outbreak_weeks and a.severity != "low"]
    quiet_weeks = (156 - 56 + 1) - len(outbreak_weeks)
    per_month = len(quiet) / quiet_weeks * 4.35
    assert per_month < 6, per_month  # "a handful per month, not dozens"

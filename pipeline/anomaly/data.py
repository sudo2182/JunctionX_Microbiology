"""Input contract for the anomaly engine, plus a CSV loader for local runs and tests.

The engine works on two long tables:

``isolates`` (one row per isolate released so far)
    isolate_id, patient_id, week_idx, sample_date, organism, specimen,
    ward_code, setting ('inpatient' | 'ed' | 'primary_care'),
    onset ('hospital' | 'community' | 'outpatient')

``markers`` (one row per isolate x marker)
    isolate_id, marker, resistant (bool)
    ``marker`` is a WHONET antibiotic code (CIP, TMP, ...) or a phenotype
    (ESBL, MRSA, VRE, CPE).

In production these come from ``lab.cultures`` / ``lab.isolates`` /
``lab.susceptibility`` after cleaning (rows flagged ``is_intrinsic`` or
``reportable = false`` dropped). ``load_csv_dir`` builds the same frames straight
from the synthetic LIS export so the engine can be run and tested without a database.
"""

from __future__ import annotations

import datetime as dt
from pathlib import Path

import pandas as pd

from .config import INTRINSIC_RESISTANCE, PHENOTYPES, URINE_ONLY_AGENTS

WEEK1_MONDAY = dt.date(2023, 10, 2)  # 2023-W40 is week_idx 1

ISOLATE_COLUMNS = [
    "isolate_id",
    "patient_id",
    "week_idx",
    "sample_date",
    "organism",
    "specimen",
    "ward_code",
    "setting",
    "onset",
]
MARKER_COLUMNS = ["isolate_id", "marker", "resistant"]


def week_label(week_idx: int) -> str:
    """'2025-W23' for week_idx 88."""
    year, week, _ = (WEEK1_MONDAY + dt.timedelta(weeks=week_idx - 1)).isocalendar()
    return f"{year}-W{week:02d}"


def week_idx_of(iso_year: int, iso_week: int) -> int:
    monday = dt.date.fromisocalendar(iso_year, iso_week, 1)
    return (monday - WEEK1_MONDAY).days // 7 + 1


def week_range_label(first: int, last: int) -> str:
    if first == last:
        return week_label(first)
    return f"{week_label(first)}..{week_label(last)}"


def derive_setting(ward_type: pd.Series, institution: pd.Series) -> pd.Series:
    out = pd.Series("ed", index=ward_type.index)
    out[ward_type == "in"] = "inpatient"
    out[institution == "primary_care"] = "primary_care"
    return out


def derive_onset(ward_type: pd.Series, sample_date: pd.Series, admission_date: pd.Series) -> pd.Series:
    """Hospital-onset = inpatient sampled on day 3+ of admission (admission day = day 1)."""
    days = (sample_date - admission_date).dt.days
    out = pd.Series("outpatient", index=ward_type.index)
    inpatient = (ward_type == "in") & admission_date.notna()
    out[inpatient] = "community"
    out[inpatient & (days >= 2)] = "hospital"
    return out


def clean_markers(markers: pd.DataFrame, isolates: pd.DataFrame) -> pd.DataFrame:
    """Drop intrinsic-resistance pairs and urine-only agents on non-urine isolates."""
    m = markers.merge(isolates[["isolate_id", "organism", "specimen"]], on="isolate_id", how="inner")
    pairs = pd.Series(list(zip(m["organism"], m["marker"], strict=True)), index=m.index)
    intrinsic = pairs.isin(INTRINSIC_RESISTANCE)
    off_label = m["marker"].isin(URINE_ONLY_AGENTS) & (m["specimen"] != "urine")
    return m.loc[~intrinsic & ~off_label, MARKER_COLUMNS].reset_index(drop=True)


def load_csv_dir(path: str | Path) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Build (isolates, markers) from the synthetic dataset's cultures/isolates/susceptibility CSVs."""
    path = Path(path)
    cu = pd.read_csv(path / "cultures.csv", parse_dates=["sample_date", "admission_date"])
    iso = pd.read_csv(path / "isolates.csv")
    su = pd.read_csv(path / "susceptibility.csv", usecols=["isolate_id", "antibiotic_code", "result"])

    cu["week_idx"] = [week_idx_of(y, w) for y, w in zip(cu["iso_year"], cu["iso_week"], strict=True)]
    cu["setting"] = derive_setting(cu["ward_type"], cu["institution"])
    cu["onset"] = derive_onset(cu["ward_type"], cu["sample_date"], cu["admission_date"])
    isolates = iso.merge(cu, on="culture_id", how="inner")[ISOLATE_COLUMNS + [p.lower() for p in PHENOTYPES]]

    ast = su.rename(columns={"antibiotic_code": "marker"})
    ast["resistant"] = ast["result"].eq("R")
    pheno = isolates.melt(
        id_vars="isolate_id", value_vars=[p.lower() for p in PHENOTYPES], var_name="marker", value_name="flag"
    )
    pheno["marker"] = pheno["marker"].str.upper()
    pheno["resistant"] = pheno["flag"].astype(int).eq(1)
    markers = pd.concat([ast[MARKER_COLUMNS], pheno[MARKER_COLUMNS]], ignore_index=True)

    isolates = isolates[ISOLATE_COLUMNS].reset_index(drop=True)
    return isolates, clean_markers(markers, isolates)

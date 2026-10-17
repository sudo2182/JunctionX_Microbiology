"""Cleaning and standardisation rules R1-R8 (BUILD_PLAN.md §3.2).

Every rule is a pure pandas function so it can be unit-tested on fixtures. `clean_batch()` applies
them to one replay batch (the staging rows for the weeks being released) and returns the frames to
insert into `lab.*`, the rejected rows, and per-week data-quality counts for `lab.dq_log`.

First-isolate de-duplication (R4) is deliberately NOT done here: it depends on the reporting window,
so `aggregate.py` does it per window. This module only keeps the keys it needs
(patient_id, organism, specimen, sample_date, isolate_id).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import timedelta

import numpy as np
import pandas as pd

from pipeline.reference import Reference
from pipeline.weeks import week_start

LAB_CULTURE_COLUMNS = [
    "culture_id", "patient_id", "sample_date", "week_idx", "iso_year", "iso_week", "ward_code",
    "setting", "specimen", "admission_date", "onset", "age_years", "age_band", "sex", "result",
    "n_isolates",
]
LAB_ISOLATE_COLUMNS = ["isolate_id", "culture_id", "organism", "quantity", "esbl", "mrsa", "vre", "cpe"]
LAB_AST_COLUMNS = ["isolate_id", "antibiotic_code", "result", "guideline", "is_intrinsic", "reportable"]
REJECT_COLUMNS = ["week_idx", "table_name", "row_key", "reason"]

AGE_BINS = [-1, 17, 64, 79, 200]
AGE_LABELS = ["0-17", "18-64", "65-79", "80+"]


@dataclass
class RawBatch:
    """Staging rows for the weeks being released. cultures must carry week_idx."""

    cultures: pd.DataFrame
    isolates: pd.DataFrame
    susceptibility: pd.DataFrame
    patients: pd.DataFrame


@dataclass
class CleanBatch:
    cultures: pd.DataFrame
    isolates: pd.DataFrame
    susceptibility: pd.DataFrame
    rejects: pd.DataFrame
    dq: list[dict] = field(default_factory=list)

    @property
    def hard_failures(self) -> list[dict]:
        return [d for d in self.dq if d["status"] == "fail"]


# --- R1 intrinsic resistance -------------------------------------------------------------------
def flag_intrinsic(organism: pd.Series, antibiotic_code: pd.Series, intrinsic: frozenset) -> pd.Series:
    pairs = pd.MultiIndex.from_arrays([organism, antibiotic_code])
    return pd.Series(pairs.isin(list(intrinsic)), index=organism.index)


# --- R2 urine-only agents ----------------------------------------------------------------------
def flag_reportable(antibiotic_code: pd.Series, specimen: pd.Series, urine_only: frozenset) -> pd.Series:
    return ~(antibiotic_code.isin(urine_only) & (specimen != "urine"))


# --- R3 hospital-onset -------------------------------------------------------------------------
def classify_onset(ward_type: pd.Series, sample_date: pd.Series, admission_date: pd.Series) -> pd.Series:
    """Hospital-onset = inpatient sampled on day 3+ of admission (admission day = day 1)."""
    sample = pd.to_datetime(sample_date)
    admit = pd.to_datetime(admission_date)
    days = (sample - admit).dt.days
    inpatient = ward_type == "in"
    out = np.select(
        [inpatient & admit.notna() & (days >= 2), inpatient & admit.notna(), ~inpatient],
        ["hospital", "community", "outpatient"],
        default="unknown",
    )
    return pd.Series(out, index=ward_type.index)


# --- R5 setting --------------------------------------------------------------------------------
def classify_setting(ward_type: pd.Series, institution: pd.Series) -> pd.Series:
    out = np.select(
        [institution == "primary_care", ward_type == "in"], ["primary_care", "inpatient"], default="ed"
    )
    return pd.Series(out, index=ward_type.index)


# --- R7 derived fields -------------------------------------------------------------------------
def age_band(age_years: pd.Series) -> pd.Series:
    return pd.cut(age_years, bins=AGE_BINS, labels=AGE_LABELS).astype("object")


def _reject(df: pd.DataFrame, mask: pd.Series, table: str, key: str, reason: str) -> pd.DataFrame:
    rows = df.loc[mask]
    return pd.DataFrame(
        {"week_idx": rows["week_idx"].values, "table_name": table, "row_key": rows[key].values, "reason": reason}
    )


# --- R6 standardisation + assembly ---------------------------------------------------------------
def clean_batch(raw: RawBatch, ref: Reference | None = None) -> CleanBatch:
    ref = ref or Reference()
    rejects: list[pd.DataFrame] = []

    cu = raw.cultures.copy()
    cu["sample_date"] = pd.to_datetime(cu["sample_date"]).dt.date
    cu["admission_date"] = pd.to_datetime(cu["admission_date"]).dt.date

    bad_ward = ~cu["ward_code"].isin(ref.wards)
    rejects.append(_reject(cu, bad_ward, "cultures", "culture_id", "unknown ward_code"))
    cu = cu.loc[~bad_ward]

    cu["onset"] = classify_onset(cu["ward_type"], cu["sample_date"], cu["admission_date"])
    cu["setting"] = classify_setting(cu["ward_type"], cu["institution"])
    cu["age_band"] = age_band(cu["age_years"])
    sex = raw.patients.set_index("patient_id")["sex"]
    cu["sex"] = cu["patient_id"].map(sex)

    week_of_culture = cu.set_index("culture_id")["week_idx"]
    specimen_of_culture = cu.set_index("culture_id")["specimen"]

    iso = raw.isolates.copy()
    iso["week_idx"] = iso["culture_id"].map(raw.cultures.set_index("culture_id")["week_idx"])
    orphan = ~iso["culture_id"].isin(cu["culture_id"])
    rejects.append(_reject(iso, orphan, "isolates", "isolate_id", "culture missing or rejected"))
    iso = iso.loc[~orphan]
    bad_org = ~iso["organism"].isin(ref.organisms)
    rejects.append(_reject(iso, bad_org, "isolates", "isolate_id", "unknown organism"))
    iso = iso.loc[~bad_org]
    for flag in ("esbl", "mrsa", "vre", "cpe"):
        iso[flag] = iso[flag].fillna(0).astype(int).astype(bool)

    ast = raw.susceptibility.copy()
    ast["week_idx"] = ast["culture_id"].map(raw.cultures.set_index("culture_id")["week_idx"])
    ast["row_key"] = ast["isolate_id"] + ":" + ast["antibiotic_code"].astype(str)
    orphan = ~ast["isolate_id"].isin(iso["isolate_id"])
    rejects.append(_reject(ast, orphan, "susceptibility", "row_key", "isolate missing or rejected"))
    ast = ast.loc[~orphan]
    bad_code = ~ast["antibiotic_code"].isin(ref.antibiotics)
    rejects.append(_reject(ast, bad_code, "susceptibility", "row_key", "unknown antibiotic_code"))
    ast = ast.loc[~bad_code]
    bad_result = ~ast["result"].isin(["S", "R"])
    rejects.append(_reject(ast, bad_result, "susceptibility", "row_key", "result not S/R"))
    invalid_results = int(bad_result.sum())
    ast = ast.loc[~bad_result]

    org_of_isolate = iso.set_index("isolate_id")["organism"]
    ast_org = ast["isolate_id"].map(org_of_isolate)
    ast_spec = ast["culture_id"].map(specimen_of_culture)
    ast["is_intrinsic"] = flag_intrinsic(ast_org, ast["antibiotic_code"], ref.intrinsic).values
    ast["reportable"] = flag_reportable(ast["antibiotic_code"], ast_spec, ref.urine_only).values

    rej = pd.concat([r for r in rejects if len(r)], ignore_index=True) if any(len(r) for r in rejects) \
        else pd.DataFrame(columns=REJECT_COLUMNS)

    batch = CleanBatch(
        cultures=cu[LAB_CULTURE_COLUMNS].reset_index(drop=True),
        isolates=iso[LAB_ISOLATE_COLUMNS].reset_index(drop=True),
        susceptibility=ast[LAB_AST_COLUMNS + ["week_idx"]].reset_index(drop=True),
        rejects=rej,
    )
    batch.dq = _counts(batch, week_of_culture, raw, invalid_results)
    return batch


def _counts(batch: CleanBatch, week_of_culture: pd.Series, raw: RawBatch, invalid_results: int) -> list[dict]:
    dq: list[dict] = []
    weeks = sorted(raw.cultures["week_idx"].unique())
    cu, iso, ast = batch.cultures, batch.isolates, batch.susceptibility
    iso_week = iso["culture_id"].map(week_of_culture)
    for w in weeks:
        w = int(w)
        a = ast[ast["week_idx"] == w]
        r = batch.rejects[batch.rejects["week_idx"] == w] if len(batch.rejects) else batch.rejects
        c = cu[cu["week_idx"] == w]

        def add(name, value, status="info", detail=None, w=w):
            dq.append({"week_idx": w, "check_name": name, "value": value, "status": status, "detail": detail})

        add("cultures_released", len(c))
        add("isolates_released", int((iso_week == w).sum()))
        add("ast_results_released", len(a))
        add("rows_rejected", len(r), "warn" if len(r) else "pass",
            "; ".join(f"{k}: {v}" for k, v in r["reason"].value_counts().items()) if len(r) else None)
        add("ast_intrinsic_excluded", int(a["is_intrinsic"].sum()))
        add("ast_not_reportable", int((~a["reportable"]).sum()))
        add("onset_unknown", int((c["onset"] == "unknown").sum()),
            "warn" if (c["onset"] == "unknown").any() else "pass")
    if invalid_results:
        dq.append({"week_idx": int(weeks[-1]), "check_name": "invalid_results", "value": invalid_results,
                   "status": "warn", "detail": "AST results outside {S, R} were rejected"})
    return dq


# --- R8 validation -------------------------------------------------------------------------------
def validate(
    batch: CleanBatch, weeks: list[int], history_weekly_cultures: pd.Series | None = None
) -> list[dict]:
    """Validation checks for each released week. A 'fail' stops the run before aggregation.

    weeks: the week_idx values this batch was meant to release.
    history_weekly_cultures: cultures per week_idx already in lab.* (for the volume check).
    """
    checks: list[dict] = []
    history = history_weekly_cultures if history_weekly_cultures is not None else pd.Series(dtype="int64")
    counts = batch.cultures.groupby("week_idx").size()
    ast_isolates = set(batch.susceptibility["isolate_id"])
    iso_week = batch.isolates["culture_id"].map(batch.cultures.set_index("culture_id")["week_idx"])
    for w in sorted(int(x) for x in weeks):
        n = int(counts.get(w, 0))
        trailing = history[(history.index < w) & (history.index >= w - 8)]
        median = float(trailing.median()) if len(trailing) else None
        if n == 0:
            status, detail = "fail", "no cultures released for this week"
        elif median and n < 0.5 * median:
            status, detail = "warn", f"{n} cultures vs trailing median {median:.0f}"
        else:
            status, detail = "pass", None
        checks.append({"week_idx": w, "check_name": "volume_vs_trailing_median", "value": n,
                       "status": status, "detail": detail})

        week_isolates = batch.isolates.loc[iso_week == w, "isolate_id"]
        missing = int((~week_isolates.isin(ast_isolates)).sum())
        checks.append({"week_idx": w, "check_name": "isolates_without_ast", "value": missing,
                       "status": "warn" if missing else "pass", "detail": None})

        c = batch.cultures[batch.cultures["week_idx"] == w]
        week_end = week_start(w) + timedelta(days=6)
        future = int((pd.to_datetime(c["sample_date"]) > pd.Timestamp(week_end)).sum())
        checks.append({"week_idx": w, "check_name": "sample_date_after_week_end", "value": future,
                       "status": "fail" if future else "pass", "detail": None})
        history = pd.concat([history, pd.Series({w: n})])
    return checks

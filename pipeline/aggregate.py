"""Window rates with first-isolate de-duplication and Wilson CI -> agg.rates (BUILD_PLAN.md §4.2).

De-duplication (CLSI M39, rule R4) happens here, per window and per scope: within the window, a
patient's first isolate of a species from a specimen type is kept (earliest sample_date, then
isolate_id). De-duplicating per week instead would over-count repeat patients against the yearly
baseline (profile: -28% of the E. coli urine denominator at 52 weeks vs -0.4% weekly).

Inputs are the released lab data (see `pipeline.db.load_lab_frames`):

isolates: isolate_id, patient_id, organism, specimen, sample_date, week_idx, ward_code, setting,
          onset, esbl, mrsa, vre, cpe
ast:      isolate_id, antibiotic_code, result, is_intrinsic, reportable
"""

from __future__ import annotations

import pandas as pd

from pipeline.reference import Reference
from pipeline.stats import wilson

WINDOWS = (1, 4, 8, 13, 52)
MIN_N = 30
MAX_WINDOW = max(WINDOWS)

# scope_type -> isolate column holding scope_value (None = hospital-wide, scope_value 'ALL')
SCOPES = {"hospital": None, "ward": "ward_code", "setting": "setting", "onset": "onset"}

# Keep agg.rates inside Supabase's free tier (~6k rows per week instead of ~13k):
# the 1-week window is only meaningful hospital-wide (only E. coli urine clears 30 weekly, §7.2),
# and specimen = 'all' is only offered at hospital level.
HOSPITAL_ONLY_WINDOWS = frozenset({1})
ALL_SPECIMEN_SCOPES = frozenset({"hospital"})

RATE_COLUMNS = [
    "end_week_idx", "window_weeks", "organism", "antibiotic_code", "specimen", "scope_type",
    "scope_value", "n_tested", "n_resistant", "pct_r", "wilson_low", "wilson_high", "reportable",
]


def first_isolates(isolates: pd.DataFrame, keys=("patient_id", "organism", "specimen")) -> pd.DataFrame:
    """CLSI M39 first isolate per patient per species per specimen within the frame given."""
    return isolates.sort_values(["sample_date", "isolate_id"]).drop_duplicates(list(keys), keep="first")


def in_window(isolates: pd.DataFrame, end_week_idx: int, window_weeks: int) -> pd.DataFrame:
    w = isolates["week_idx"]
    return isolates[(w > end_week_idx - window_weeks) & (w <= end_week_idx)]


def _finish(df: pd.DataFrame) -> pd.DataFrame:
    df["pct_r"] = (100 * df["n_resistant"] / df["n_tested"]).round(2)
    low, high = wilson(df["n_resistant"], df["n_tested"])
    df["wilson_low"] = pd.Series(low, index=df.index).round(2)
    df["wilson_high"] = pd.Series(high, index=df.index).round(2)
    df["reportable"] = df["n_tested"] >= MIN_N
    return df


def _rates_for_scope(
    win: pd.DataFrame, ast_ok: pd.DataFrame, scope_col: str, ref: Reference, with_all_specimens: bool
) -> pd.DataFrame:
    parts = []
    for specimen_mode in ("each", "all") if with_all_specimens else ("each",):
        if specimen_mode == "each":
            firsts = first_isolates(win, (scope_col, "patient_id", "organism", "specimen"))
        else:
            firsts = first_isolates(win, (scope_col, "patient_id", "organism")).assign(specimen="all")
        keys = [scope_col, "organism", "specimen"]

        tested = firsts[keys + ["isolate_id"]].merge(ast_ok, on="isolate_id")
        if len(tested):
            g = tested.groupby(keys + ["antibiotic_code"], observed=True)["is_r"]
            parts.append(
                pd.DataFrame({"n_tested": g.size(), "n_resistant": g.sum().astype(int)}).reset_index()
            )

        for marker, (flag, organisms) in ref.phenotypes.items():
            sub = firsts[firsts["organism"].isin(organisms)]
            if sub.empty:
                continue
            g = sub.groupby(keys, observed=True)[flag]
            parts.append(
                pd.DataFrame({"n_tested": g.size(), "n_resistant": g.sum().astype(int)})
                .reset_index()
                .assign(antibiotic_code=marker)
            )
    if not parts:
        return pd.DataFrame()
    return pd.concat(parts, ignore_index=True).rename(columns={scope_col: "scope_value"})


def compute_rates(
    isolates: pd.DataFrame,
    ast: pd.DataFrame,
    end_week_idx: int,
    windows=WINDOWS,
    ref: Reference | None = None,
) -> pd.DataFrame:
    """All agg.rates rows for one end week. Intrinsic and non-reportable AST rows never count."""
    ref = ref or Reference()
    ast_ok = ast.loc[~ast["is_intrinsic"].astype(bool) & ast["reportable"].astype(bool),
                     ["isolate_id", "antibiotic_code", "result"]]
    ast_ok = ast_ok.assign(is_r=ast_ok["result"] == "R").drop(columns="result")
    iso = isolates.assign(_hospital="ALL")
    out = []
    for window_weeks in windows:
        win = in_window(iso, end_week_idx, window_weeks)
        if win.empty:
            continue
        for scope_type, col in SCOPES.items():
            if window_weeks in HOSPITAL_ONLY_WINDOWS and scope_type != "hospital":
                continue
            scope_col = col or "_hospital"
            rates = _rates_for_scope(win, ast_ok, scope_col, ref, scope_type in ALL_SPECIMEN_SCOPES)
            if rates.empty:
                continue
            out.append(rates.assign(end_week_idx=end_week_idx, window_weeks=window_weeks, scope_type=scope_type))
    if not out:
        return pd.DataFrame(columns=RATE_COLUMNS)
    df = pd.concat(out, ignore_index=True)
    df["scope_value"] = df["scope_value"].astype(str)
    return _finish(df)[RATE_COLUMNS]


def dedup_summary(isolates: pd.DataFrame, end_week_idx: int, window_weeks: int = 4) -> dict:
    """How many isolates first-isolate de-duplication removed, hospital-wide, for the quality page."""
    win = in_window(isolates, end_week_idx, window_weeks)
    kept = len(first_isolates(win))
    return {"window_weeks": window_weeks, "isolates": len(win), "first_isolates": kept, "removed": len(win) - kept}


def run(conn, weeks: list[int], run_id: str, ref: Reference | None = None) -> dict:
    """Recompute agg.rates for each end week in `weeks` and log de-duplication counts to lab.dq_log."""
    from pipeline import db

    if not weeks:
        return {"weeks": 0, "rows": 0}
    isolates, ast = db.load_lab_frames(conn, min(weeks) - MAX_WINDOW + 1, max(weeks))
    frames, dq = [], []
    for w in weeks:
        frames.append(compute_rates(isolates, ast, w, ref=ref))
        s = dedup_summary(isolates, w)
        dq.append({"run_id": run_id, "week_idx": w, "check_name": "first_isolate_removed_4w",
                   "value": s["removed"], "status": "info",
                   "detail": f"{s['first_isolates']} first isolates of {s['isolates']} in the 4-week window"})
    rates = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=RATE_COLUMNS)
    with conn.cursor() as cur:
        cur.execute("delete from agg.rates where end_week_idx = any(%s)", (list(weeks),))
    db.upsert_df(conn, "agg.rates", rates, RATE_COLUMNS)
    db.write_dq(conn, pd.DataFrame(dq))
    conn.commit()
    return {"weeks": len(weeks), "rows": len(rates)}

"""Benchmark inspector: look at what the THL importers (thl_nidr, finres) produce and what is stored.

    pip install -r tools/benchmark_inspector/requirements.txt
    streamlit run tools/benchmark_inspector/app.py          # run from the repository root

Two views of the data:
  * Live import preview: runs the same parser as `python -m pipeline.benchmarks` and shows its output.
    thl_nidr calls THL's open API (needs internet); finres reads pipeline/benchmarks/data. No database needed.
  * Stored in Supabase: reads bench.* read-only. Set SUPABASE_DB_URL in your shell or in a git-ignored .env.

The app never writes anything. Nothing here is sent anywhere except the request to THL's public API.
"""

from __future__ import annotations

import dataclasses
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import pandas as pd  # noqa: E402
import streamlit as st  # noqa: E402

from pipeline.benchmarks import finres, thl_nidr  # noqa: E402
from pipeline.benchmarks.model import KEY_FIELDS, ValidationError, validate  # noqa: E402

SOURCES = {
    "thl_nidr": ("THL infectious diseases register (cases, incidence)", thl_nidr.DATASET),
    "finres": ("THL Finres (% resistant, n tested)", finres.DATASET),
}
SOURCE_IDS = {"thl_nidr": thl_nidr.SOURCE_ID, "finres": finres.SOURCE_ID}   # menu key -> bench.sources.source_id
SERIES = ["geo_code", "organism", "antimicrobial", "phenotype", "specimen", "sex", "age_band", "indicator"]
SMALL_N = 30
st.set_page_config(page_title="Benchmark inspector", layout="wide")


# ------------------------------------------------------------------------------------------- data access
def _frame(rows) -> pd.DataFrame:
    df = pd.DataFrame([dataclasses.asdict(r) for r in rows])
    if df.empty:
        return df
    df["year"] = pd.to_datetime(df["period_start"]).dt.year
    return df.drop(columns=["import_run_id"], errors="ignore")


@st.cache_data(ttl=3600, show_spinner="Fetching and parsing…")
def load_live(source: str, from_year: int, nonce: int):
    """Run the real importer parser. nonce only exists so the Refresh button can bypass the cache."""
    batch = thl_nidr.load(from_year) if source == "thl_nidr" else finres.load()
    try:
        validate(batch.rows, where=source)
        problem = None
    except ValidationError as exc:
        problem = str(exc)
    meta = {
        "source_url": batch.source_url, "retrieved_at": batch.retrieved_at, "skipped": batch.skipped,
        "input_sha256": batch.input_sha256, "notes": batch.notes, "validation_error": problem,
    }
    return _frame(batch.rows), meta


def db_url() -> str | None:
    if os.environ.get("SUPABASE_DB_URL"):
        return os.environ["SUPABASE_DB_URL"]
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("SUPABASE_DB_URL=") and line.split("=", 1)[1].strip():
                return line.split("=", 1)[1].strip().strip("\"'")
    return None


@st.cache_data(ttl=60, show_spinner="Reading Supabase (read-only)…")
def query_db(_url: str, sql: str, params: tuple = ()) -> pd.DataFrame:
    import psycopg

    with psycopg.connect(_url, prepare_threshold=None) as conn:
        conn.read_only = True
        with conn.cursor() as cur:
            cur.execute(sql, params)
            cols = [d.name for d in cur.description]
            return pd.DataFrame(cur.fetchall(), columns=cols)


def load_db(url: str, source: str) -> pd.DataFrame:
    df = query_db(url, "select * from bench.observations where source_id = %s", (source,))
    if not df.empty:
        df["year"] = pd.to_datetime(df["period_start"]).dt.year
        for c in ("value", "ci_low", "ci_high"):
            df[c] = pd.to_numeric(df[c])
    return df


# ------------------------------------------------------------------------------------------- analysis
def series_label(df: pd.DataFrame) -> pd.Series:
    marker = df["antimicrobial"].where(df["antimicrobial"] != "", df["phenotype"]).replace("", "-")
    return (df["organism"] + " · " + marker + " · " + df["specimen"] + " · " + df["sex"] + " · "
            + df["geo_code"] + " · " + df["indicator"])


def coverage(df: pd.DataFrame) -> pd.DataFrame:
    d = df.assign(series=series_label(df))
    return d.pivot_table(index="series", columns="year", values="value", aggfunc="count").fillna(0).astype(int)


def quality_checks(df: pd.DataFrame, meta: dict | None) -> pd.DataFrame:
    rows: list[tuple[str, str, str]] = []

    def add(name, ok, detail, warn=False):
        rows.append((name, "pass" if ok else ("warn" if warn else "FAIL"), detail))

    if meta is not None:
        add("Importer validation (model.validate)", meta["validation_error"] is None,
            meta["validation_error"] or "every row passed the importer's own checks")
        add("Cells skipped by the importer", True,
            f"{meta['skipped']} source cells had no published value (never stored as 0)")
    if df.empty:
        add("Any rows", False, "no rows")
        return pd.DataFrame(rows, columns=["check", "status", "detail"])
    keys = [k for k in KEY_FIELDS if k in df.columns]
    dup_rows = df[df.duplicated(subset=keys, keep=False)]
    conflicting = int(dup_rows.groupby(keys, dropna=False)["value"].nunique().gt(1).sum()) if len(dup_rows) else 0
    extra = int(df.duplicated(subset=keys).sum())
    add("Duplicate natural keys with different values", conflicting == 0, f"{conflicting} keys conflict")
    add("Identical duplicate rows", extra == 0,
        f"{extra} repeated rows with the same values; the importer merges them before storing "
        f"(so the stored row count is {len(df) - extra:,})", warn=True)
    add("Missing values", df["value"].notna().all(), f"{int(df['value'].isna().sum())} rows without a value")
    neg = int((df["value"] < 0).sum())
    add("Negative values", neg == 0, f"{neg} rows")
    pct = df[df["indicator"] == "pct_resistant"]
    if len(pct):
        bad = int(((pct["value"] < 0) | (pct["value"] > 100)).sum())
        add("Percentages within 0-100", bad == 0, f"{bad} outside the range of {len(pct)}")
        no_n = int(pct["denominator"].isna().sum())
        add("Every % has an n tested", no_n == 0, f"{no_n} percentages without a denominator")
        small = int((pct["denominator"] < SMALL_N).sum())
        add(f"Percentages with n < {SMALL_N}", small == 0, f"{small} rows: unstable, do not read as precise", warn=True)
    cov = coverage(df)
    ragged = int((cov.eq(0).any(axis=1)).sum())
    add("Series with a missing year inside their range", ragged == 0,
        f"{ragged} of {len(cov)} series have a gap (see the Coverage tab)", warn=True)
    cur = pd.Timestamp.now().year
    add("Most recent complete year present", int(df["year"].max()) >= cur - 2,
        f"latest year {int(df['year'].max())}", warn=True)
    if "retrieved_at" in df.columns:
        add("Provenance recorded", df["retrieved_at"].notna().all() and df["source_url"].notna().all(),
            "retrieved_at and source_url on every row")
    return pd.DataFrame(rows, columns=["check", "status", "detail"])


def diff_live_vs_db(live: pd.DataFrame, stored: pd.DataFrame) -> pd.DataFrame:
    keys = [k for k in KEY_FIELDS if k not in ("period_start", "period_end")] + ["year"]
    cols = keys + ["value", "numerator", "denominator"]
    # The importer merges identical duplicate rows before storing them, so compare like with like.
    unique_live = live[cols].drop_duplicates(subset=keys)
    m = unique_live.merge(stored[cols], on=keys, how="outer", suffixes=("_live", "_db"), indicator=True)
    names = {"left_only": "only in live source", "right_only": "only in Supabase", "both": "both"}
    m["status"] = m["_merge"].astype(str).map(names)
    both = m["status"] == "both"
    changed = both & ((m["value_live"] - m["value_db"]).abs() > 1e-9)
    m.loc[changed, "status"] = "value differs"
    m.loc[both & ~changed, "status"] = "identical"
    return m.drop(columns="_merge")


# ------------------------------------------------------------------------------------------- UI
st.title("Benchmark inspector")
st.caption("What the THL importers get, and what is stored. Read-only: this app never writes anything.")

with st.sidebar:
    source = st.radio("Source", list(SOURCES), format_func=lambda s: SOURCES[s][0])
    url = db_url()
    modes = ["Live import preview"] + (["Stored in Supabase"] if url else [])
    mode = st.radio("Data shown", modes)
    if not url:
        st.info("Supabase view is off: set `SUPABASE_DB_URL` in your shell or a git-ignored `.env` and restart.")
    from_year = 2015
    if source == "thl_nidr":
        from_year = st.number_input("First year to fetch", 2010, 2025, 2015)
    if "nonce" not in st.session_state:
        st.session_state.nonce = 0
    if st.button("Re-fetch from source") and mode == "Live import preview":
        st.session_state.nonce += 1
        st.cache_data.clear()

meta = None
try:
    live_df, live_meta = load_live(source, int(from_year), st.session_state.nonce)
except Exception as exc:  # noqa: BLE001  show the failure instead of a stack trace
    live_df, live_meta = pd.DataFrame(), None
    st.error(f"The live importer failed: {exc}")

if mode == "Stored in Supabase":
    try:
        df = load_db(url, SOURCE_IDS[source])
    except Exception as exc:  # noqa: BLE001
        df = pd.DataFrame()
        st.error(f"Could not read Supabase: {type(exc).__name__}: {exc}")
    meta = None
else:
    df, meta = live_df, live_meta

if df.empty:
    st.warning("No rows to show for this selection.")
    st.stop()

tabs = st.tabs(["Overview", "Explorer", "Trends", "Coverage", "Quality checks", "Live vs Supabase",
                "Runs & provenance", "Comparability"])

with tabs[0]:
    c = st.columns(5)
    c[0].metric("Rows", f"{len(df):,}")
    c[1].metric("Years", f"{int(df['year'].min())}-{int(df['year'].max())}")
    c[2].metric("Distinct series", f"{len(coverage(df)):,}")
    c[3].metric("Geographies", df["geo_code"].nunique())
    c[4].metric("Organisms", df["organism"].nunique())
    st.write(f"**Source:** {SOURCES[source][0]} · dataset `{SOURCES[source][1]}` · showing: **{mode}**")
    if meta:
        st.write(f"Retrieved {meta['retrieved_at']:%Y-%m-%d %H:%M} UTC from {meta['source_url'][:140]}")
        if meta["input_sha256"]:
            st.write(f"SHA-256 of the bytes parsed: `{meta['input_sha256']}`")
        for n in meta["notes"]:
            st.write(f"Note: {n}")
    left, right = st.columns(2)
    left.subheader("Rows by indicator")
    left.dataframe(df.groupby("indicator").size().rename("rows"), width="stretch")
    right.subheader("Rows by year")
    right.bar_chart(df.groupby("year").size())
    left.subheader("Rows by specimen")
    left.dataframe(df.groupby("specimen").size().rename("rows"), width="stretch")
    right.subheader("Rows by organism")
    right.dataframe(df.groupby("organism").size().rename("rows"), width="stretch")
    if source == "thl_nidr":
        st.info("THL register rows are notified **cases** and **incidence per 100,000**. They are not a % resistant.")
    else:
        st.info("Finres rows are the **% resistant** of tested first isolates, with n tested. Counts of resistant "
                "isolates are not published, so none are shown.")

with tabs[1]:
    f = df
    cols = st.columns(4)
    yr = cols[0].slider("Years", int(df["year"].min()), int(df["year"].max()),
                        (int(df["year"].min()), int(df["year"].max())))
    f = f[f["year"].between(*yr)]
    pick = {}
    row2 = st.columns(5)
    for box, field in zip(row2, ["geo_name", "organism", "specimen", "indicator", "sex"], strict=True):
        opts = sorted(f[field].dropna().unique())
        pick[field] = box.multiselect(field, opts)
    marker_opts = sorted((set(f["antimicrobial"]) | set(f["phenotype"])) - {""})
    markers = st.multiselect("antimicrobial / phenotype", marker_opts)
    for field, chosen in pick.items():
        if chosen:
            f = f[f[field].isin(chosen)]
    if markers:
        f = f[f["antimicrobial"].isin(markers) | f["phenotype"].isin(markers)]
    show = ["year", "geo_name", "organism", "antimicrobial", "phenotype", "specimen", "sex", "indicator", "value",
            "unit", "numerator", "denominator", "ci_low", "ci_high", "table_ref", "coverage_note", "release",
            "retrieved_at", "source_url"]
    st.write(f"{len(f):,} of {len(df):,} rows")
    st.dataframe(f[[c for c in show if c in f.columns]].sort_values(["organism", "year"]), width="stretch",
                 height=520)
    st.download_button("Download these rows (CSV)", f.to_csv(index=False).encode(), f"{source}_filtered.csv")

with tabs[2]:
    c = st.columns(5)
    org = c[0].selectbox("Organism", sorted(df["organism"].unique()))
    d = df[df["organism"] == org].copy()
    d["marker"] = d["antimicrobial"].where(d["antimicrobial"] != "", d["phenotype"]).replace("", "-")
    marker = c[1].selectbox("Marker", sorted(d["marker"].unique()))
    d = d[d["marker"] == marker]
    spec = c[2].selectbox("Specimen", sorted(d["specimen"].unique()))
    d = d[d["specimen"] == spec]
    sex = c[3].selectbox("Sex", sorted(d["sex"].unique()))
    d = d[d["sex"] == sex]
    ind = c[4].selectbox("Indicator", sorted(d["indicator"].unique()))
    d = d[d["indicator"] == ind]
    wide = d.pivot_table(index="year", columns="geo_name", values="value", aggfunc="first")
    st.subheader(f"{org} · {marker} · {spec} · {sex} · {ind}")
    st.line_chart(wide)
    st.dataframe(d[["year", "geo_name", "value", "unit", "numerator", "denominator", "ci_low", "ci_high",
                    "table_ref", "coverage_note"]].sort_values(["geo_name", "year"]), width="stretch")
    if ind == "pct_resistant":
        st.caption("A percentage without its n tested is not interpretable. Check the denominator column; "
                   f"rows with n < {SMALL_N} are unstable.")

with tabs[3]:
    st.write("Number of stored values per series and year. A 0 inside a series' range is a gap in the source "
             "(not published, or skipped), never a zero value.")
    cov = coverage(df)
    gaps_only = st.checkbox("Only series with a gap")
    if gaps_only:
        cov = cov[cov.eq(0).any(axis=1)]
    st.dataframe(cov.style.map(lambda v: "background-color: #f4b6b6" if v == 0 else ""), width="stretch",
                 height=520)

with tabs[4]:
    qc = quality_checks(df, meta)
    st.dataframe(qc.style.map(lambda v: {"pass": "color: #1a7f37", "warn": "color: #9a6700",
                                         "FAIL": "color: #cf222e"}.get(v, ""), subset=["status"]),
                 width="stretch")
    st.caption("`warn` means worth a look but not an error. `FAIL` means the data should not be used until explained.")

with tabs[5]:
    if not url:
        st.info("Needs SUPABASE_DB_URL (see the sidebar).")
    elif live_df.empty:
        st.warning("The live importer returned nothing to compare.")
    else:
        stored = load_db(url, SOURCE_IDS[source])
        if stored.empty:
            st.warning("Nothing is stored in Supabase for this source yet.")
        else:
            d = diff_live_vs_db(live_df, stored)
            counts = d["status"].value_counts()
            c = st.columns(4)
            for box, label in zip(c, ["identical", "value differs", "only in live source", "only in Supabase"],
                                  strict=True):
                box.metric(label, int(counts.get(label, 0)))
            if counts.get("identical", 0) == len(d):
                st.success("Supabase matches what the importer would fetch right now.")
            else:
                st.warning("Differences found. 'only in live source' means a newer import would add rows; "
                           "'value differs' means the source has revised published figures.")
            choice = st.multiselect("Show", sorted(d["status"].unique()), default=[s for s in d["status"].unique()
                                                                                    if s != "identical"])
            st.dataframe(d[d["status"].isin(choice)], width="stretch", height=420)

with tabs[6]:
    if not url:
        st.info("Needs SUPABASE_DB_URL (see the sidebar).")
    else:
        st.subheader("Import runs")
        runs_sql = ("select run_id, dataset, status, started_at, finished_at, rows_parsed, rows_inserted, "
                    "rows_updated, rows_unchanged, rows_skipped, input_sha256, error, run_url "
                    "from bench.import_runs where source_id = %s order by run_id desc limit 50")
        runs = query_db(url, runs_sql, (SOURCE_IDS[source],))
        st.dataframe(runs, width="stretch")
        st.subheader("Source record")
        st.dataframe(query_db(url, "select * from bench.sources where source_id = %s", (SOURCE_IDS[source],)).T,
                     width="stretch")

with tabs[7]:
    st.write("Which series may be shown beside which local TYKS rate (`ref.benchmark_comparability`). "
             "No row means no comparison. Counts and incidence never appear here.")
    comp = pd.read_csv(ROOT / "pipeline" / "benchmarks" / "data" / "comparability.csv")
    comp = comp[comp["source_id"] == SOURCE_IDS[source]]
    if comp.empty:
        st.info("This source has no comparability rows: it is context only and is never compared with local rates.")
    else:
        st.dataframe(comp, width="stretch")

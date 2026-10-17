"""Thin Postgres layer (psycopg 3). All rule logic lives in clean.py / aggregate.py, not here."""

from __future__ import annotations

import io

import pandas as pd
import psycopg

from pipeline.reference import Reference


def connect(url: str) -> psycopg.Connection:
    # prepare_threshold=None: Supabase's transaction pooler does not support prepared statements.
    return psycopg.connect(url, autocommit=False, prepare_threshold=None)


def read_df(conn: psycopg.Connection, sql: str, params=None) -> pd.DataFrame:
    with conn.cursor() as cur:
        cur.execute(sql, params)
        cols = [d.name for d in cur.description]
        return pd.DataFrame(cur.fetchall(), columns=cols)


def copy_df(conn: psycopg.Connection, table: str, df: pd.DataFrame, columns: list[str]) -> None:
    """COPY a frame into `table` (no conflict handling; use for empty/staging tables)."""
    buf = io.StringIO()
    df[columns].to_csv(buf, index=False, header=False, na_rep="\\N")
    buf.seek(0)
    cols = ", ".join(columns)
    with conn.cursor() as cur, cur.copy(f"copy {table} ({cols}) from stdin with (format csv, null '\\N')") as cp:
        while chunk := buf.read(1 << 20):
            cp.write(chunk)


def upsert_df(
    conn: psycopg.Connection, table: str, df: pd.DataFrame, columns: list[str], conflict: str = "do nothing"
) -> None:
    """COPY into a temp table, then insert ... on conflict <conflict>. Idempotent re-runs insert nothing."""
    if df.empty:
        return
    tmp = "_tmp_" + table.replace(".", "_")
    with conn.cursor() as cur:
        cur.execute(f"create temp table {tmp} (like {table} including defaults) on commit drop")
    copy_df(conn, tmp, df, columns)
    cols = ", ".join(columns)
    with conn.cursor() as cur:
        cur.execute(f"insert into {table} ({cols}) select {cols} from {tmp} on conflict {conflict}")
        cur.execute(f"drop table {tmp}")


DQ_COLUMNS = ["run_id", "week_idx", "check_name", "value", "status", "detail"]


def write_dq(conn: psycopg.Connection, dq: pd.DataFrame) -> None:
    """Upsert data-quality rows into lab.dq_log (a re-run of the same run_id overwrites its values)."""
    if dq.empty:
        return
    upsert_df(
        conn, "lab.dq_log", dq, DQ_COLUMNS,
        conflict="(run_id, week_idx, check_name) do update set value = excluded.value, "
                 "status = excluded.status, detail = excluded.detail",
    )


def load_reference(conn: psycopg.Connection) -> Reference:
    with conn.cursor() as cur:
        cur.execute("select name from ref.organisms")
        organisms = frozenset(r[0] for r in cur.fetchall())
        cur.execute("select antibiotic_code, reported_for from ref.antibiotics")
        ab = cur.fetchall()
        cur.execute("select organism, antibiotic_code from ref.intrinsic_resistance")
        intrinsic = frozenset(tuple(r) for r in cur.fetchall())
        cur.execute("select ward_code from ref.wards")
        wards = frozenset(r[0] for r in cur.fetchall())
        cur.execute("select marker, organism from ref.phenotypes")
        ph: dict[str, list[str]] = {}
        for marker, org in cur.fetchall():
            ph.setdefault(marker, []).append(org)
    return Reference(
        organisms=organisms,
        antibiotics=frozenset(code for code, _ in ab),
        urine_only=frozenset(code for code, rf in ab if rf == "urine"),
        intrinsic=intrinsic,
        wards=wards,
        phenotypes={m: (m.lower(), tuple(sorted(orgs))) for m, orgs in ph.items()},
    )


def load_lab_frames(conn: psycopg.Connection, from_week: int, to_week: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    """Released isolates (joined to culture context) and AST rows for week_idx in [from_week, to_week]."""
    isolates = read_df(
        conn,
        """
        select i.isolate_id, c.patient_id, i.organism, c.specimen, c.sample_date, c.week_idx,
               c.ward_code, c.setting, c.onset, i.esbl, i.mrsa, i.vre, i.cpe
        from lab.isolates i join lab.cultures c using (culture_id)
        where c.week_idx between %s and %s
        """,
        (from_week, to_week),
    )
    ast = read_df(
        conn,
        """
        select s.isolate_id, s.antibiotic_code, s.result, s.is_intrinsic, s.reportable
        from lab.susceptibility s
        join lab.isolates i using (isolate_id) join lab.cultures c using (culture_id)
        where c.week_idx between %s and %s
        """,
        (from_week, to_week),
    )
    return isolates, ast

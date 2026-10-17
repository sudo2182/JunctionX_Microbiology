"""Write validated observations to bench.observations, with a bench.import_runs record for every attempt.

A run row is committed first, so a failed import is still on record; the observations themselves go in one
transaction, so a bad batch leaves the table exactly as it was. Re-importing identical input changes nothing.
"""

from __future__ import annotations

import csv
import dataclasses
import datetime as dt
import hashlib
import logging
from dataclasses import dataclass, field
from pathlib import Path

from pipeline import config
from pipeline.benchmarks.model import COLUMNS, VALUE_FIELDS, Observation, ValidationError, validate

log = logging.getLogger(__name__)

DATA_DIR = Path(__file__).parent / "data"
MARKERS = frozenset({"ESBL", "MRSA", "VRE", "CPE"})


@dataclass
class Batch:
    """What a source parser hands to the store."""

    source_id: str
    dataset: str
    rows: list[Observation]
    source_url: str
    retrieved_at: dt.datetime
    skipped: int = 0                       # cells with no published value, or outside the requested scope
    input_name: str | None = None
    input_sha256: str | None = None
    notes: list[str] = field(default_factory=list)


@dataclass
class RunResult:
    run_id: int | None
    source_id: str
    dataset: str
    parsed: int = 0
    inserted: int = 0
    updated: int = 0
    unchanged: int = 0
    skipped: int = 0
    dry_run: bool = False
    notes: list[str] = field(default_factory=list)

    def summary(self) -> str:
        tag = " (dry run)" if self.dry_run else ""
        merged = [n for n in self.notes if "merged" in n]
        extra = f" ({'; '.join(merged)})" if merged else ""
        return (f"{self.source_id}/{self.dataset}{tag}: parsed {self.parsed}, inserted {self.inserted}, "
                f"updated {self.updated}, unchanged {self.unchanged}, skipped {self.skipped}{extra}")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _open_run(conn, batch: Batch) -> int:
    with conn.cursor() as cur:
        cur.execute(
            "insert into bench.import_runs"
            " (source_id, dataset, source_url, input_name, input_sha256, retrieved_at, run_url)"
            " values (%s, %s, %s, %s, %s, %s, %s) returning run_id",
            (batch.source_id, batch.dataset, batch.source_url, batch.input_name, batch.input_sha256,
             batch.retrieved_at, config.run_url()),
        )
        run_id = cur.fetchone()[0]
    conn.commit()
    return run_id


def _close_run(conn, run_id: int, status: str, res: RunResult, error: str | None = None) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "update bench.import_runs set finished_at = now(), status = %s, rows_parsed = %s, rows_inserted = %s,"
            " rows_updated = %s, rows_unchanged = %s, rows_skipped = %s, error = %s where run_id = %s",
            (status, res.parsed, res.inserted, res.updated, res.unchanged, res.skipped, error, run_id),
        )
    conn.commit()


def _load_existing(conn, batch: Batch) -> dict[tuple, tuple]:
    releases = sorted({r.release for r in batch.rows})
    with conn.cursor() as cur:
        cur.execute(
            f"select {', '.join(VALUE_FIELDS)}, source_id, dataset, release, indicator, period_start, period_end,"
            " geo_level, geo_code, organism, antimicrobial, phenotype, specimen, sex, age_band"
            " from bench.observations where source_id = %s and dataset = %s and release = any(%s)",
            (batch.source_id, batch.dataset, releases),
        )
        out = {}
        for row in cur.fetchall():
            n = len(VALUE_FIELDS)
            out[tuple(row[n:])] = tuple(row[:n])
    return out


def _same(old: tuple, new: Observation) -> bool:
    for name, a in zip(VALUE_FIELDS, old):
        b = getattr(new, name)
        if a is None or b is None:
            if a is not b:
                return False
        elif isinstance(b, (int, float)) and not isinstance(b, bool):
            if abs(float(a) - float(b)) > 1e-9:
                return False
        elif a != b:
            return False
    return True


UPSERT_SQL = (
    f"insert into bench.observations ({', '.join(COLUMNS)}) values ({', '.join(['%s'] * len(COLUMNS))})"
    " on conflict on constraint observations_natural_key do update set "
    + ", ".join(f"{c} = excluded.{c}" for c in COLUMNS
                if c not in ("source_id", "dataset", "release", "indicator", "period_start", "period_end", "geo_level",
                             "geo_code", "organism", "antimicrobial", "phenotype", "specimen", "sex", "age_band"))
)


def collapse_identical(rows: list[Observation]) -> list[Observation]:
    """A source can print one series twice (Finres tables 20 and 22 both carry blood ESBL). Keep one row and
    cite both places; validate() has already refused duplicates whose values differ."""
    merged: dict[tuple, Observation] = {}
    for r in rows:
        first = merged.get(r.key)
        if first is None:
            merged[r.key] = r
        elif r.table_ref and r.table_ref not in (first.table_ref or ""):
            merged[r.key] = dataclasses.replace(first, table_ref=f"{first.table_ref}; {r.table_ref}")
    return list(merged.values())


def import_batch(conn, batch: Batch, dry_run: bool = False) -> RunResult:
    """Validate and upsert one batch. Raises (after recording a failed run) if anything is wrong."""
    res = RunResult(None, batch.source_id, batch.dataset, parsed=len(batch.rows), skipped=batch.skipped,
                    dry_run=dry_run, notes=list(batch.notes))
    run_id = None if dry_run else _open_run(conn, batch)
    res.run_id = run_id
    try:
        validate(batch.rows, where=f"{batch.source_id}/{batch.dataset}")
        rows = collapse_identical(batch.rows)
        if len(rows) != len(batch.rows):
            res.notes.append(f"{len(batch.rows) - len(rows)} identical duplicate rows merged")
        existing = _load_existing(conn, batch)
        to_write = []
        for r in rows:
            old = existing.get(r.key)
            if old is None:
                res.inserted += 1
                to_write.append(r)
            elif _same(old, r):
                res.unchanged += 1
            else:
                res.updated += 1
                to_write.append(r)
        if not dry_run:
            for r in to_write:
                r.import_run_id, r.retrieved_at = run_id, batch.retrieved_at
            with conn.cursor() as cur:
                cur.executemany(UPSERT_SQL, [r.values() for r in to_write])
            _close_run(conn, run_id, "succeeded", res)
    except Exception as exc:
        conn.rollback()
        if run_id is not None:
            _close_run(conn, run_id, "failed", res, error=str(exc)[:2000])
        raise
    log.info(res.summary())
    return res


def sync_comparability(conn, path: Path = DATA_DIR / "comparability.csv") -> int:
    """Upsert the reviewed comparability table, refusing rows that point at unknown local organisms or codes."""
    with open(path, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))
    with conn.cursor() as cur:
        cur.execute("select name from ref.organisms")
        organisms = {r[0] for r in cur.fetchall()}
        cur.execute("select antibiotic_code from ref.antibiotics")
        codes = {r[0] for r in cur.fetchall()} | MARKERS
    problems = []
    for i, r in enumerate(rows, start=2):
        if r["organism"] not in organisms:
            problems.append(f"line {i}: unknown organism {r['organism']!r}")
        if r["antibiotic_code"] not in codes:
            problems.append(f"line {i}: unknown local antibiotic_code {r['antibiotic_code']!r}")
        if r["comparable"] not in ("true", "false"):
            problems.append(f"line {i}: comparable must be true or false")
        if not r["caveat"].strip():
            problems.append(f"line {i}: caveat is required")
    if problems:
        raise ValidationError(f"{path.name}: " + "; ".join(problems[:20]))
    with conn.cursor() as cur:
        cur.executemany(
            "insert into ref.benchmark_comparability (source_id, organism, antibiotic_code, specimen,"
            " ext_antimicrobial, ext_phenotype, ext_specimen, sex, comparable, comparison_kind, caveat)"
            " values (%(source_id)s, %(organism)s, %(antibiotic_code)s, %(specimen)s, %(ext_antimicrobial)s,"
            " %(ext_phenotype)s, %(ext_specimen)s, %(sex)s, %(comparable)s::boolean, %(comparison_kind)s, %(caveat)s)"
            " on conflict (source_id, organism, antibiotic_code, specimen, ext_antimicrobial, ext_phenotype,"
            " ext_specimen, sex) do update set comparable = excluded.comparable,"
            " comparison_kind = excluded.comparison_kind, caveat = excluded.caveat",
            rows,
        )
    conn.commit()
    return len(rows)


def record_failure(conn, source_id: str, dataset: str, error: str) -> None:
    """A run that failed before it had a batch (e.g. the source was unreachable) is still logged."""
    with conn.cursor() as cur:
        cur.execute(
            "insert into bench.import_runs (source_id, dataset, status, finished_at, error, run_url)"
            " values (%s, %s, 'failed', now(), %s, %s)",
            (source_id, dataset, error[:2000], config.run_url()),
        )
    conn.commit()

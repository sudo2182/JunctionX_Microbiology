"""Monthly benchmark refresh: parse each source, validate, diff against bench.rates, upsert changes.

Input per source, in order (later wins on the same key):
  1. committed exports in pipeline/benchmarks/raw/<source>_*.csv (sorted by name)
  2. an optional download from BENCH_<SOURCE>_URL (set as a GitHub Actions variable)
A failed download falls back to the committed files with a warning. Any validation error
aborts the run before anything is written.
"""

from __future__ import annotations

import datetime as dt
import logging
import os
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

from pipeline.benchmarks import ecdc, glass, thl
from pipeline.benchmarks.model import BenchRow, validate

log = logging.getLogger(__name__)

RAW_DIR = Path(__file__).parent / "raw"
PARSERS = {"ecdc": ecdc.parse, "thl": thl.parse, "glass": glass.parse}
COLUMNS = (
    "source",
    "country",
    "year",
    "organism",
    "antimicrobial_group",
    "specimen_scope",
    "n_tested",
    "pct_r",
    "ci_low",
    "ci_high",
    "retrieved_at",
    "source_url",
)


@dataclass
class SourceResult:
    source: str
    files: list[str] = field(default_factory=list)
    rows: list[BenchRow] = field(default_factory=list)
    new: list[BenchRow] = field(default_factory=list)
    changed: list[BenchRow] = field(default_factory=list)
    unchanged: int = 0
    warnings: list[str] = field(default_factory=list)

    @property
    def years(self) -> list[int]:
        return sorted({r.year for r in self.rows})

    @property
    def new_years(self) -> list[int]:
        return sorted({r.year for r in self.new})


def download(url: str, timeout: int = 60) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "amr-watch-benchmarks/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8-sig")


def collect(source: str, raw_dir: Path = RAW_DIR, url: str | None = None) -> SourceResult:
    res = SourceResult(source)
    texts: list[tuple[str, str]] = [
        (p.name, p.read_text(encoding="utf-8-sig")) for p in sorted(raw_dir.glob(f"{source}_*.csv"))
    ]
    if url:
        try:
            texts.append((url, download(url)))
        except Exception as exc:  # noqa: BLE001  network, 404, proxy: keep going on committed files
            res.warnings.append(f"download failed ({exc}); using committed files")
    merged: dict[tuple, BenchRow] = {}
    for name, text in texts:
        rows = PARSERS[source](text)
        validate(rows, where=f"{source}:{name}")
        res.files.append(name)
        for r in rows:
            merged[r.key] = r
    res.rows = list(merged.values())
    if not texts:
        res.warnings.append("no export committed and no download URL set; skipped")
    return res


def diff(res: SourceResult, existing: dict[tuple, tuple[int | None, float]]) -> None:
    """Split rows into new / changed / unchanged against bench.rates (key -> (n_tested, pct_r))."""
    res.new, res.changed, res.unchanged = [], [], 0
    for r in res.rows:
        old = existing.get(r.key)
        if old is None:
            res.new.append(r)
        elif old[0] != r.n_tested or abs(float(old[1]) - r.pct_r) > 1e-6:
            res.changed.append(r)
        else:
            res.unchanged += 1


def load_existing(conn, sources: list[str]) -> dict[tuple, tuple[int | None, float]]:
    with conn.cursor() as cur:
        cur.execute(
            "select source, country, year, organism, antimicrobial_group, specimen_scope, n_tested, pct_r"
            " from bench.rates where source = any(%s)",
            (sources,),
        )
        return {tuple(r[:6]): (r[6], float(r[7])) for r in cur.fetchall()}


UPSERT_SQL = (
    f"insert into bench.rates ({', '.join(COLUMNS)}) values ({', '.join(['%s'] * len(COLUMNS))})"
    " on conflict (source, country, year, organism, antimicrobial_group, specimen_scope) do update set"
    " n_tested = excluded.n_tested, pct_r = excluded.pct_r, ci_low = excluded.ci_low,"
    " ci_high = excluded.ci_high, retrieved_at = excluded.retrieved_at, source_url = excluded.source_url"
)


def upsert(conn, rows: list[BenchRow], now: dt.datetime) -> int:
    if not rows:
        return 0
    params = []
    for r in rows:
        r.retrieved_at = now
        params.append(tuple(getattr(r, c) for c in COLUMNS))
    with conn.cursor() as cur:
        cur.executemany(UPSERT_SQL, params)
    return len(params)


def summary_markdown(results: list[SourceResult], dry_run: bool) -> str:
    lines = [
        f"## Benchmark refresh{' (dry run)' if dry_run else ''}",
        "",
        "| Source | Files | Rows | Years | New | Changed | Unchanged | New years | Notes |",
        "|---|---|---|---|---|---|---|---|---|",
    ]
    for r in results:
        years = f"{r.years[0]}–{r.years[-1]}" if r.years else "–"
        lines.append(
            f"| {r.source} | {len(r.files)} | {len(r.rows)} | {years} | {len(r.new)} | {len(r.changed)} | "
            f"{r.unchanged} | {', '.join(map(str, r.new_years)) or '–'} | {'; '.join(r.warnings) or ''} |"
        )
    return "\n".join(lines) + "\n"


def run(
    *,
    sources: list[str],
    conn=None,
    raw_dir: Path = RAW_DIR,
    urls: dict[str, str] | None = None,
    dry_run: bool = False,
    now: dt.datetime | None = None,
) -> list[SourceResult]:
    now = now or dt.datetime.now(dt.UTC).replace(microsecond=0)
    urls = urls if urls is not None else {s: os.environ.get(f"BENCH_{s.upper()}_URL", "") for s in sources}
    results = [collect(s, raw_dir, urls.get(s) or None) for s in sources]  # raises before any write

    existing = load_existing(conn, sources) if conn is not None else {}
    for res in results:
        diff(res, existing)

    if conn is not None and not dry_run:
        n = sum(upsert(conn, res.new + res.changed, now) for res in results)
        conn.commit()
        log.info("upserted %d bench.rates rows", n)

    md = summary_markdown(results, dry_run or conn is None)
    log.info("\n%s", md)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as fh:
            fh.write(md)
    return results

"""Tidy-CSV parser shared by THL (Finres tables) and WHO GLASS downloads.

Expected columns (case-insensitive; common aliases accepted):
  country, year, organism, antimicrobial_group, specimen_scope, n_tested,
  pct_r  (or n_resistant), [ci_low, ci_high, source_url]
"""

from __future__ import annotations

import csv
import io

from pipeline.benchmarks.model import BenchRow, ValidationError, norm_country, norm_group, norm_scope

ALIASES = {
    "country": ("country", "countryterritoryarea", "iso3", "iso2", "region", "regioncode"),
    "year": ("year", "time", "vuosi"),
    "organism": ("organism", "pathogen", "pathogenname", "bacteria"),
    "antimicrobial_group": (
        "antimicrobial_group",
        "antimicrobial",
        "antibiotic",
        "antibioticname",
        "abtargets",
        "group",
    ),
    "specimen_scope": ("specimen_scope", "specimen", "specimentype", "infectiontype"),
    "n_tested": ("n_tested", "tested", "numtested", "interpretableast", "n"),
    "n_resistant": ("n_resistant", "resistant", "numresistant"),
    "pct_r": ("pct_r", "percent_resistant", "percentresistant", "resistance_pct", "r_pct", "%r"),
    "ci_low": ("ci_low", "lower_ci", "ci_lower"),
    "ci_high": ("ci_high", "upper_ci", "ci_upper"),
    "source_url": ("source_url", "url", "source"),
}


def _get(row: dict[str, str], field: str) -> str:
    for alias in ALIASES[field]:
        v = row.get(alias)
        if v not in (None, ""):
            return v.strip()
    return ""


def _f(text: str) -> float | None:
    text = text.replace(",", ".").replace("%", "").strip()
    return None if text in ("", "-", "NA") else float(text)


def parse(text: str, source: str, default_url: str, default_scope: str = "all") -> list[BenchRow]:
    rows: list[BenchRow] = []
    reader = csv.DictReader(io.StringIO(text.lstrip("﻿")))
    for i, raw in enumerate(reader, start=2):
        row = {(k or "").strip().lower(): v for k, v in raw.items()}
        if not any((v or "").strip() for v in row.values()):
            continue
        n = _f(_get(row, "n_tested"))
        pct = _f(_get(row, "pct_r"))
        if pct is None:
            x = _f(_get(row, "n_resistant"))
            if x is None or not n:
                raise ValidationError(f"{source} line {i}: needs pct_r, or n_resistant with n_tested")
            pct = 100 * x / n
        r = BenchRow(
            source=source,
            country=norm_country(_get(row, "country")),
            year=int(float(_get(row, "year") or 0)),
            organism=_get(row, "organism"),
            antimicrobial_group=norm_group(_get(row, "antimicrobial_group")),
            specimen_scope=norm_scope(_get(row, "specimen_scope") or default_scope),
            n_tested=int(n) if n is not None else None,
            pct_r=round(pct, 2),
            ci_low=_f(_get(row, "ci_low")),
            ci_high=_f(_get(row, "ci_high")),
            source_url=_get(row, "source_url") or default_url,
        )
        r.fill_ci()
        rows.append(r)
    return rows

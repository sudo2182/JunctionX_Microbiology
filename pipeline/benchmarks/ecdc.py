"""ECDC Surveillance Atlas (EARS-Net) CSV export -> bench rows.

The Atlas export is long format, one value per row:
  HealthTopic, Population, Indicator, Unit, Time, RegionCode, RegionName, NumValue, TxtValue
Population is "<organism>|<antimicrobial group>", e.g. "Escherichia coli|Third-generation
cephalosporins". The %R row ("R - resistant isolates, percentage") and the denominator row
("Total tested isolates") are paired per population, year and region. EARS-Net is invasive
isolates only (blood / CSF).
"""

from __future__ import annotations

import csv
import io

from pipeline.benchmarks.model import BenchRow, norm_country, norm_group

SOURCE = "ecdc"
SOURCE_URL = "https://atlas.ecdc.europa.eu/public/index.aspx"
DEFAULT_COUNTRIES = ("FI", "EU/EEA")


def _col(row: dict, *names: str) -> str:
    lower = {k.strip().lower(): v for k, v in row.items() if k}
    for n in names:
        if n.lower() in lower and lower[n.lower()] is not None:
            return lower[n.lower()].strip()
    return ""


def _num(text: str) -> float | None:
    text = text.strip().replace(",", ".")
    if text in ("", "-", "NA", "n/a"):
        return None
    return float(text)


def _kind(indicator: str, unit: str) -> str | None:
    ind = indicator.lower()
    if ind.startswith(("r -", "r-")) or "resistant isolates, percentage" in ind:
        return "pct" if unit.strip() in ("%", "") or "percentage" in ind else None
    if ind.startswith(("total tested", "total number of tested")):
        return "n"
    return None


def parse(text: str, countries: tuple[str, ...] = DEFAULT_COUNTRIES) -> list[BenchRow]:
    cells: dict[tuple, dict[str, float]] = {}
    for row in csv.DictReader(io.StringIO(text.lstrip("﻿"))):
        kind = _kind(_col(row, "Indicator"), _col(row, "Unit"))
        if kind is None:
            continue
        population = _col(row, "Population")
        if "|" not in population:
            continue
        organism, group = (p.strip() for p in population.split("|", 1))
        country = norm_country(_col(row, "RegionCode") or _col(row, "RegionName", "Region"))
        if country not in countries:
            continue
        value = _num(_col(row, "NumValue", "Value"))
        if value is None:
            continue
        key = (country, int(_col(row, "Time", "Year")), organism, norm_group(group))
        cells.setdefault(key, {})[kind] = value

    rows = []
    for (country, year, organism, group), vals in sorted(cells.items()):
        if "pct" not in vals:
            continue  # a denominator without a %R is not a benchmark
        n = vals.get("n")
        r = BenchRow(
            source=SOURCE,
            country=country,
            year=year,
            organism=organism,
            antimicrobial_group=group,
            specimen_scope="invasive",
            n_tested=int(n) if n is not None else None,
            pct_r=round(vals["pct"], 2),
            source_url=SOURCE_URL,
        )
        r.fill_ci()
        rows.append(r)
    return rows

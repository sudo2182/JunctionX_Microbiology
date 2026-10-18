"""One external observation, and the checks every batch must pass before anything is written."""

from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass, field

SOURCES = ("ecdc_ears_net", "thl_finres", "thl_nidr")
SPECIMENS = ("blood_csf", "urine", "pus", "carriage", "all")
INDICATORS = ("pct_resistant", "cases", "incidence_per_100k")
GEO_LEVELS = ("eu_eea", "country", "county")
SEXES = ("all", "female", "male")

# Columns of bench.observations written by the importer, in insert order.
COLUMNS = (
    "source_id", "dataset", "release", "table_ref", "import_run_id", "source_url", "retrieved_at",
    "period_type", "period_start", "period_end", "geo_level", "geo_code", "geo_name",
    "organism", "organism_src", "antimicrobial", "antimicrobial_src", "phenotype", "specimen", "sex", "age_band",
    "indicator", "value", "unit", "numerator", "denominator", "ci_low", "ci_high",
    "breakpoint_standard", "dedup_rule", "case_definition", "coverage_note", "value_status", "derivation",
)
KEY_FIELDS = (
    "source_id", "dataset", "release", "indicator", "period_start", "period_end",
    "geo_level", "geo_code", "organism", "antimicrobial", "phenotype", "specimen", "sex", "age_band",
)
# Fields compared to decide whether an existing row changed (provenance such as retrieved_at is excluded).
VALUE_FIELDS = ("value", "numerator", "denominator", "ci_low", "ci_high", "unit", "table_ref", "source_url")


class ValidationError(ValueError):
    """A batch had problems; nothing was written."""


@dataclass
class Observation:
    source_id: str
    dataset: str
    release: str
    source_url: str
    period_start: dt.date
    period_end: dt.date
    geo_level: str
    geo_code: str
    geo_name: str
    organism: str
    organism_src: str
    specimen: str
    indicator: str
    value: float
    unit: str
    table_ref: str | None = None
    antimicrobial: str = ""
    antimicrobial_src: str = ""
    phenotype: str = ""
    sex: str = "all"
    age_band: str = "all"
    numerator: int | None = None
    denominator: int | None = None
    ci_low: float | None = None
    ci_high: float | None = None
    breakpoint_standard: str | None = None
    dedup_rule: str | None = None
    case_definition: str | None = None
    coverage_note: str | None = None
    value_status: str = "published"
    derivation: str | None = None
    period_type: str = "year"
    import_run_id: int | None = field(default=None, repr=False)
    retrieved_at: dt.datetime | None = field(default=None, repr=False)

    @property
    def key(self) -> tuple:
        return tuple(getattr(self, f) for f in KEY_FIELDS)

    @property
    def label(self) -> str:
        return "/".join(
            str(x) for x in (self.dataset, self.period_start.year, self.geo_code, self.organism,
                             self.antimicrobial or self.phenotype or "-", self.specimen, self.sex, self.indicator)
        )

    def values(self) -> tuple:
        return tuple(getattr(self, c) for c in COLUMNS)


def validate(rows: list[Observation], where: str = "") -> None:
    """Raise ValidationError listing every problem found (first 20)."""
    problems: list[str] = []
    seen: dict[tuple, Observation] = {}
    this_year = dt.datetime.now(dt.UTC).year
    if not rows:
        problems.append("no observations parsed")
    for r in rows:
        tag = r.label
        if r.source_id not in SOURCES:
            problems.append(f"{tag}: unknown source_id {r.source_id!r}")
        if r.specimen not in SPECIMENS:
            problems.append(f"{tag}: unknown specimen {r.specimen!r}")
        if r.indicator not in INDICATORS:
            problems.append(f"{tag}: unknown indicator {r.indicator!r}")
        if r.geo_level not in GEO_LEVELS:
            problems.append(f"{tag}: unknown geo_level {r.geo_level!r}")
        if r.sex not in SEXES:
            problems.append(f"{tag}: unknown sex {r.sex!r}")
        if not (r.geo_code and r.geo_name and r.organism and r.organism_src):
            problems.append(f"{tag}: geo_code, geo_name, organism and organism_src are required")
        if not (1990 <= r.period_start.year <= this_year):
            problems.append(f"{tag}: implausible year {r.period_start.year}")
        if r.period_end < r.period_start:
            problems.append(f"{tag}: period ends before it starts")
        if r.period_end >= dt.datetime.now(dt.UTC).date():
            problems.append(f"{tag}: period is not finished yet; only complete years are imported")
        if not isinstance(r.value, (int, float)) or math.isnan(r.value) or r.value < 0:
            problems.append(f"{tag}: invalid value {r.value!r}")
        elif r.indicator == "pct_resistant" and r.value > 100:
            problems.append(f"{tag}: percentage {r.value} above 100")
        for name in ("numerator", "denominator"):
            v = getattr(r, name)
            if v is not None and v < 0:
                problems.append(f"{tag}: negative {name}")
        if r.numerator is not None and r.denominator is not None and r.numerator > r.denominator:
            problems.append(f"{tag}: numerator {r.numerator} exceeds denominator {r.denominator}")
        if r.value_status == "derived" and not r.derivation:
            problems.append(f"{tag}: derived value without a derivation")
        prev = seen.get(r.key)
        if prev is not None and any(getattr(prev, f) != getattr(r, f) for f in ("value", "numerator", "denominator")):
            problems.append(f"{tag}: duplicate key with different values")
        seen[r.key] = r
    if problems:
        head = f"{where}: " if where else ""
        more = f" ... ({len(problems)} problems)" if len(problems) > 20 else ""
        raise ValidationError(head + "; ".join(problems[:20]) + more)


def year_bounds(year: int) -> tuple[dt.date, dt.date]:
    return dt.date(year, 1, 1), dt.date(year, 12, 31)

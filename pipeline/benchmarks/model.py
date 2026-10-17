"""bench.rates row model, normalisation helpers and validation."""

from __future__ import annotations

import datetime as dt
import math
import re
from dataclasses import dataclass

SOURCES = ("ecdc", "thl", "glass")
SPECIMEN_SCOPES = ("invasive", "urine", "all")
KEY_FIELDS = ("source", "country", "year", "organism", "antimicrobial_group", "specimen_scope")

# Free-text group names seen in source exports -> canonical antimicrobial_group.
_GROUP_ALIASES = {
    "meticillin (mrsa)": "mrsa",
    "methicillin (mrsa)": "mrsa",
    "meticillin": "mrsa",
    "methicillin": "mrsa",
    "mrsa": "mrsa",
    "oxacillin": "mrsa",
    "cefoxitin": "mrsa",
    "piperacillin + tazobactam": "piperacillin_tazobactam",
    "piperacillin/tazobactam": "piperacillin_tazobactam",
    "piperacillin-tazobactam": "piperacillin_tazobactam",
    "third-generation cephalosporins": "third_generation_cephalosporins",
    "3rd generation cephalosporins": "third_generation_cephalosporins",
    "3gc": "third_generation_cephalosporins",
    "ceftriaxone": "third_generation_cephalosporins",
    "cefotaxime": "third_generation_cephalosporins",
    "aminopenicillins": "aminopenicillins",
    "ampicillin": "aminopenicillins",
    "fluoroquinolones": "fluoroquinolones",
    "ciprofloxacin": "fluoroquinolones",
    "levofloxacin": "fluoroquinolones",
    "carbapenems": "carbapenems",
    "meropenem": "carbapenems",
    "imipenem": "carbapenems",
}

_COUNTRIES = {
    "FI": "FI",
    "FIN": "FI",
    "FINLAND": "FI",
    "SE": "SE",
    "SWE": "SE",
    "SWEDEN": "SE",
    "NO": "NO",
    "NOR": "NO",
    "NORWAY": "NO",
    "DK": "DK",
    "DNK": "DK",
    "DENMARK": "DK",
    "EE": "EE",
    "EST": "EE",
    "ESTONIA": "EE",
}


def norm_group(label: str) -> str:
    key = label.strip().lower()
    if key in _GROUP_ALIASES:
        return _GROUP_ALIASES[key]
    return re.sub(r"[^a-z0-9]+", "_", key).strip("_")


def norm_country(value: str) -> str:
    v = value.strip()
    up = v.upper()
    if up in _COUNTRIES:
        return _COUNTRIES[up]
    if up.startswith("EU") or "EEA" in up:
        return "EU/EEA"
    return v


def norm_scope(value: str) -> str:
    v = value.strip().lower()
    if v in ("invasive", "blood", "bloodstream", "blood/csf", "csf"):
        return "invasive"
    if v in ("urine", "urinary", "urinary tract"):
        return "urine"
    if v in ("all", "any", ""):
        return "all"
    return v


def wilson(x: float, n: int, z: float = 1.96) -> tuple[float, float]:
    """95% Wilson interval in percent."""
    if n <= 0:
        return (math.nan, math.nan)
    p = x / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
    return (round(100 * max(0.0, centre - half), 2), round(100 * min(1.0, centre + half), 2))


@dataclass
class BenchRow:
    source: str
    country: str
    year: int
    organism: str
    antimicrobial_group: str
    specimen_scope: str
    n_tested: int | None
    pct_r: float
    ci_low: float | None = None
    ci_high: float | None = None
    source_url: str | None = None
    retrieved_at: dt.datetime | None = None

    @property
    def key(self) -> tuple:
        return tuple(getattr(self, f) for f in KEY_FIELDS)

    def fill_ci(self) -> None:
        if self.ci_low is None and self.n_tested and 0 <= self.pct_r <= 100:
            self.ci_low, self.ci_high = wilson(self.pct_r / 100 * self.n_tested, self.n_tested)


class ValidationError(ValueError):
    pass


def validate(rows: list[BenchRow], where: str = "") -> None:
    """Raise ValidationError listing every problem; nothing is written if any row is bad."""
    problems: list[str] = []
    seen: dict[tuple, BenchRow] = {}
    this_year = dt.datetime.now(dt.UTC).year
    if not rows:
        problems.append("no rows parsed")
    for r in rows:
        tag = f"{r.source}/{r.country}/{r.year}/{r.organism}/{r.antimicrobial_group}/{r.specimen_scope}"
        if r.source not in SOURCES:
            problems.append(f"{tag}: unknown source")
        if not r.country or not r.organism or not r.antimicrobial_group:
            problems.append(f"{tag}: missing country, organism or group")
        if not 1990 <= r.year <= this_year + 1:
            problems.append(f"{tag}: implausible year")
        if r.specimen_scope not in SPECIMEN_SCOPES:
            problems.append(f"{tag}: specimen_scope must be one of {SPECIMEN_SCOPES}")
        if not 0 <= r.pct_r <= 100 or math.isnan(r.pct_r):
            problems.append(f"{tag}: pct_r {r.pct_r} outside 0-100")
        if r.n_tested is not None and r.n_tested < 0:
            problems.append(f"{tag}: negative n_tested")
        prev = seen.get(r.key)
        if prev is not None and (prev.pct_r, prev.n_tested) != (r.pct_r, r.n_tested):
            problems.append(f"{tag}: duplicate key with different values")
        seen[r.key] = r
    if problems:
        head = f"{where}: " if where else ""
        raise ValidationError(head + "; ".join(problems[:20]) + (" ..." if len(problems) > 20 else ""))

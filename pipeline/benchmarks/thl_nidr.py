"""THL National Infectious Diseases Register (statistical database, cases) via THL's open JSON-stat API.

Only the resistance-related reporting groups are read: notified cases and incidence per 100,000 population for
invasive (blood/CSF) isolates and for carriage. These are counts, never "percent resistant", and they are stored
as such. Values THL does not publish for a cell are skipped and counted, not stored as zero.

Query syntax (row= / column= with category ids from the dimensions file) is the one THL's pivot API accepts;
labels in the response are checked against what we expect, so a renumbered category fails loudly.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

from pipeline.benchmarks import net
from pipeline.benchmarks.model import Observation, ValidationError, year_bounds
from pipeline.benchmarks.store import Batch, sha256_bytes

log = logging.getLogger(__name__)

SOURCE_ID = "thl_nidr"
DATASET = "nidr_cases"
BASE = "https://sampo.thl.fi/pivot/prod/en/ttr/cases/fact_ttr_cases"
DIMENSIONS_URL = BASE + ".dimensions.json"
USER_AGENT = "amr-watch-benchmarks/1.0 (JunctionX Turku hackathon project)"

DIM_GROUP, DIM_TIME, DIM_AREA, DIM_MEASURE = "nidrreportgroup", "yearmonth", "wscmunicipality2022", "measure"
NATIONAL = "All areas"
DEFAULT_COUNTIES = ("Southwest Finland wellbeing services county",)  # where Tyks is
MEASURES = ("Cases", "Incidence", "Population")


@dataclass(frozen=True)
class Item:
    label: str          # reporting group exactly as THL writes it
    organism: str
    phenotype: str
    specimen: str


ITEMS = (
    Item("S. aureus, blood/liquor MRSA", "Staphylococcus aureus", "MRSA", "blood_csf"),
    Item("S. aureus, blood/liquor not MRSA", "Staphylococcus aureus", "not_MRSA", "blood_csf"),
    Item("ESBL blood/liquor, E.coli", "Escherichia coli", "ESBL", "blood_csf"),
    Item("ESBL blood/liquor, K.pneumoniae", "Klebsiella pneumoniae", "ESBL", "blood_csf"),
    Item("VRE blood/liquor", "Enterococcus spp.", "VRE", "blood_csf"),
    Item("MRSA carriership", "Staphylococcus aureus", "MRSA", "carriage"),
    Item("ESBL-carriership, E.coli", "Escherichia coli", "ESBL", "carriage"),
    Item("ESBL-carriership, K.pneumoniae", "Klebsiella pneumoniae", "ESBL", "carriage"),
    Item("VRE carriership", "Enterococcus spp.", "VRE", "carriage"),
    Item("CPE carriership, E. coli", "Escherichia coli", "CPE", "carriage"),
    Item("CPE carriership, K. pneumoniae", "Klebsiella pneumoniae", "CPE", "carriage"),
    Item("CPE carriership, E. cloacae", "Enterobacter cloacae", "CPE", "carriage"),
)
ITEM_BY_LABEL = {i.label: i for i in ITEMS}


def fetch(url: str, timeout: int = 60, attempts: int = 3) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
    for attempt in range(1, attempts + 1):
        try:
            with net.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except (urllib.error.URLError, TimeoutError) as exc:
            if isinstance(exc, urllib.error.HTTPError) and 400 <= exc.code < 500:
                raise
            if attempt == attempts:
                raise
            log.warning("THL request failed (%s); retry %d/%d", exc, attempt, attempts - 1)
            time.sleep(2 ** attempt)
    raise AssertionError("unreachable")


def parse_dimensions(raw: bytes) -> dict[str, dict[str, int]]:
    """Dimensions come as JSONP (`thl.pivot.loadDimensions([...])`): label -> category id for each dimension."""
    text = raw.decode("utf-8")
    nodes = json.loads(text[text.index("["): text.rindex("]") + 1])
    out: dict[str, dict[str, int]] = {}
    for dim in nodes:
        labels: dict[str, list[int]] = {}

        def walk(n, labels=labels):
            labels.setdefault(n["label"], []).append(n["sid"])
            for c in n.get("children") or []:
                walk(c)

        for child in dim.get("children") or []:
            walk(child)
        out[dim["id"]] = {k: v[0] for k, v in labels.items() if len(v) == 1}
    return out


def _sid(dims: dict[str, dict[str, int]], dim: str, label: str) -> int:
    try:
        return dims[dim][label]
    except KeyError:
        raise ValidationError(
            f"THL dimension {dim!r} has no unique category {label!r}; the register layout changed") from None


def build_url(dims: dict[str, dict[str, int]], years: list[int], areas: list[str]) -> str:
    groups = ".".join(str(_sid(dims, DIM_GROUP, i.label)) for i in ITEMS)
    yrs = ".".join(str(_sid(dims, DIM_TIME, f"Year {y}")) for y in years)
    ars = ".".join(str(_sid(dims, DIM_AREA, a)) for a in areas)
    meas = ".".join(str(_sid(dims, DIM_MEASURE, m)) for m in MEASURES)
    query = f"row={DIM_GROUP}-{groups}.&column={DIM_TIME}-{yrs}.&column={DIM_AREA}-{ars}.&column={DIM_MEASURE}-{meas}."
    return f"{BASE}.json?{query}"


def available_years(dims: dict[str, dict[str, int]], from_year: int, today: dt.date | None = None) -> list[int]:
    """Complete calendar years THL has a category for (the running year is partial and never imported)."""
    this_year = (today or dt.datetime.now(dt.UTC).date()).year
    ys = []
    for label in dims[DIM_TIME]:
        if label.startswith("Year ") and label[5:].isdigit():
            y = int(label[5:])
            if from_year <= y < this_year:
                ys.append(y)
    return sorted(ys)


def _number(raw) -> float | None:
    if raw is None:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


def parse_response(raw: bytes, source_url: str, retrieved_at: dt.datetime) -> tuple[list[Observation], int]:
    """JSON-stat -> observations (cases and incidence rows) plus the number of cells with no published value."""
    data = json.loads(raw)["dataset"]
    dim = data["dimension"]
    ids, sizes = dim["id"], dim["size"]
    if set(ids) != {DIM_GROUP, DIM_TIME, DIM_AREA, DIM_MEASURE}:
        raise ValidationError(f"unexpected THL dimensions {ids}")
    labels = {i: {v: dim[i]["category"]["label"][k] for k, v in dim[i]["category"]["index"].items()} for i in ids}
    values = data["value"]
    get = values.get if isinstance(values, dict) else (lambda k: values[int(k)] if int(k) < len(values) else None)

    strides, acc = {}, 1
    for i, s in zip(reversed(ids), reversed(sizes)):
        strides[i], acc = acc, acc * s

    def cell(g: int, t: int, a: int, m: int) -> float | None:
        flat = g * strides[DIM_GROUP] + t * strides[DIM_TIME] + a * strides[DIM_AREA] + m * strides[DIM_MEASURE]
        return _number(get(str(flat)))

    pos = {i: {label: p for p, label in labels[i].items()} for i in ids}
    unknown = [lbl for lbl in pos[DIM_GROUP] if lbl not in ITEM_BY_LABEL]
    if unknown:
        raise ValidationError(f"THL returned unexpected reporting groups: {unknown}")
    rows: list[Observation] = []
    skipped = 0
    for glabel, g in pos[DIM_GROUP].items():
        item = ITEM_BY_LABEL[glabel]
        for tlabel, t in pos[DIM_TIME].items():
            if not (tlabel.startswith("Year ") and tlabel[5:].isdigit()):
                raise ValidationError(f"unexpected time category {tlabel!r}")
            year = int(tlabel[5:])
            start, end = year_bounds(year)
            for alabel, a in pos[DIM_AREA].items():
                geo = ("country", "FI", "Finland") if alabel == NATIONAL else None
                if geo is None:
                    geo = ("county", f"wsc:{_county_code(alabel)}", alabel)
                m = {name: cell(g, t, a, pos[DIM_MEASURE][name]) for name in pos[DIM_MEASURE]}
                cases, incidence, population = m.get("Cases"), m.get("Incidence"), m.get("Population")
                common = dict(
                    source_id=SOURCE_ID, dataset=DATASET, release="live", source_url=source_url,
                    period_start=start, period_end=end, geo_level=geo[0], geo_code=geo[1], geo_name=geo[2],
                    organism=item.organism, organism_src=item.label, phenotype=item.phenotype, specimen=item.specimen,
                    case_definition=f"THL reporting group: {item.label}",
                    table_ref="National Infectious Diseases Register, statistical database - cases",
                )
                if cases is None:
                    skipped += 1
                else:
                    rows.append(Observation(**common, indicator="cases", value=cases, unit="cases"))
                if incidence is None:
                    skipped += 1
                else:
                    rows.append(Observation(
                        **common, indicator="incidence_per_100k", value=incidence, unit="per 100,000 population",
                        numerator=int(cases) if cases is not None else None,
                        denominator=int(population) if population is not None else None,
                    ))
    return rows, skipped


# THL's area codes are shown in its dimensions file; the two we use are fixed here and checked on import.
_COUNTY_CODES = {"Southwest Finland wellbeing services county": "05"}


def _county_code(label: str) -> str:
    try:
        return _COUNTY_CODES[label]
    except KeyError:
        raise ValidationError(
            f"no THL area code recorded for {label!r}; add it to _COUNTY_CODES from the dimensions file") from None


def load(from_year: int = 2015, counties: tuple[str, ...] = DEFAULT_COUNTIES, today: dt.date | None = None) -> Batch:
    dims = parse_dimensions(fetch(DIMENSIONS_URL))
    years = available_years(dims, from_year, today)
    if not years:
        raise ValidationError(f"THL has no complete year from {from_year}")
    url = build_url(dims, years, [NATIONAL, *counties])
    raw = fetch(url)
    retrieved_at = dt.datetime.now(dt.UTC).replace(microsecond=0)
    rows, skipped = parse_response(raw, url, retrieved_at)
    return Batch(SOURCE_ID, DATASET, rows, url, retrieved_at, skipped=skipped, input_sha256=sha256_bytes(raw),
                 notes=[f"years {years[0]}-{years[-1]}"])

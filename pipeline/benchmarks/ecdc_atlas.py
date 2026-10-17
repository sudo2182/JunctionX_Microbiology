"""ECDC Surveillance Atlas (EARS-Net) CSV export -> observations.

The Atlas has no documented API, so the input is the Atlas's own "Export CSV" file, downloaded by a person.
The raw export is not committed (ECDC's data disclaimer asks recipients not to redistribute it): it lives in the
private Storage bucket `benchmark-raw`, and git holds only manifest/ecdc_atlas.json with its SHA-256. An import
refuses a file whose checksum is not in the manifest, so what is in the database is traceable to exact bytes.

Expected columns (long format, one value per row): HealthTopic, Population, Indicator, Unit, Time, RegionCode,
RegionName, NumValue. These names are not published by ECDC; if a real export differs the parser stops with the
headers it found instead of guessing (`python -m pipeline.benchmarks --inspect-ecdc FILE` prints them).
"""

from __future__ import annotations

import csv
import datetime as dt
import io
import json
import re
from pathlib import Path

from pipeline.benchmarks.model import Observation, ValidationError, year_bounds
from pipeline.benchmarks.store import Batch, sha256_bytes

SOURCE_ID = "ecdc_ears_net"
DATASET = "ears_net_atlas"
SOURCE_URL = "https://atlas.ecdc.europa.eu/public/index.aspx?Dataset=27&HealthTopic=4"
MANIFEST = Path(__file__).parent / "manifest" / "ecdc_atlas.json"
REQUIRED = ("HealthTopic", "Population", "Indicator", "Unit", "Time", "RegionCode", "RegionName", "NumValue")
DEFAULT_COUNTRIES = ("FI",)

# From ECDC's "Information about the Data: Antimicrobial resistance" (Surveillance Atlas, 2025).
BREAKPOINTS = "EUCAST only from 2019 data onward; earlier years may include other interpretive criteria"
COVERAGE = ("No percentage is calculated when fewer than 20 isolates were tested; population coverage differs "
            "between countries and over time")

# Atlas antimicrobial labels (lower case) that denote a phenotype share rather than an antimicrobial group.
PHENOTYPE_LABELS = {"meticillin (mrsa)": "MRSA", "methicillin (mrsa)": "MRSA"}


def slug(label: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")


def read_manifest(path: Path = MANIFEST) -> dict:
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"files": []}


def check_manifest(name: str, sha256: str, manifest: dict) -> dict:
    """The manifest entry for this exact file, or ValidationError (unknown name, or same name with other bytes)."""
    for entry in manifest["files"]:
        if entry["name"] == name:
            if entry["sha256"] != sha256:
                raise ValidationError(
                    f"{name}: checksum {sha256} does not match the manifest ({entry['sha256']}); the file changed. "
                    "Save a new export under a new name and register it.")
            return entry
    raise ValidationError(f"{name} is not in {MANIFEST.name}; register it first (--register)")


def register(name: str, data: bytes, retrieved_on: str, note: str, storage_path: str | None,
             path: Path = MANIFEST) -> dict:
    manifest = read_manifest(path)
    sha = sha256_bytes(data)
    if any(e["name"] == name for e in manifest["files"]):
        raise ValidationError(f"{name} is already in the manifest; use a new file name for a new export")
    entry = {"name": name, "sha256": sha, "retrieved_on": retrieved_on, "export_note": note,
             "storage_path": storage_path or f"benchmark-raw/{name}"}
    manifest["files"].append(entry)
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return entry


def inspect(data: bytes) -> str:
    text = data.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(text))
    rows = list(reader)
    inds = sorted({r.get("Indicator", "") for r in rows})[:15]
    pops = sorted({r.get("Population", "") for r in rows})[:15]
    return f"headers: {reader.fieldnames}\nrows: {len(rows)}\nindicators: {inds}\npopulations: {pops}"


def _kind(indicator: str) -> str | None:
    ind = indicator.strip().lower()
    if ind.startswith("r -") and "percentage" in ind:
        return "pct"
    if ind.startswith("total tested"):
        return "n"
    return None


def parse(data: bytes, name: str, retrieved_on: str, countries: tuple[str, ...] = DEFAULT_COUNTRIES,
          today: dt.date | None = None) -> tuple[list[Observation], int]:
    reader = csv.DictReader(io.StringIO(data.decode("utf-8-sig")))
    missing = [c for c in REQUIRED if c not in (reader.fieldnames or [])]
    if missing:
        raise ValidationError(f"{name}: missing columns {missing}; found {reader.fieldnames}")
    this_year = (today or dt.datetime.now(dt.UTC).date()).year
    cells: dict[tuple, dict[str, float]] = {}
    skipped = 0
    n_pct = 0
    for line_no, row in enumerate(reader, start=2):
        kind = _kind(row["Indicator"])
        if kind is None:
            skipped += 1
            continue
        population = row["Population"]
        if "|" not in population:
            raise ValidationError(
                f"{name} line {line_no}: Population {population!r} is not '<organism>|<antimicrobial>'")
        region_code, region_name = row["RegionCode"].strip(), row["RegionName"].strip()
        is_eu = region_name.upper().startswith("EU/EEA") or region_code.upper().startswith("EU/EEA")
        if region_code not in countries and not is_eu:
            skipped += 1
            continue
        if not re.fullmatch(r"\d{4}", row["Time"].strip()):
            raise ValidationError(f"{name} line {line_no}: Time {row['Time']!r} is not a calendar year")
        year = int(row["Time"])
        if year >= this_year:
            skipped += 1
            continue
        raw_value = row["NumValue"].strip().replace(",", ".")
        if raw_value in ("", "-", ".", "NA"):      # Atlas symbols: '-' not calculated (<20 isolates), '.' not reported
            skipped += 1
            continue
        try:
            value = float(raw_value)
        except ValueError:
            raise ValidationError(f"{name} line {line_no}: NumValue {row['NumValue']!r} is not a number") from None
        organism, group = (p.strip() for p in population.split("|", 1))
        geo = ("eu_eea", region_code, region_name) if is_eu else ("country", region_code, region_name)
        cells.setdefault((*geo, year, organism, group), {})[kind] = value
        n_pct += kind == "pct"
    if not n_pct:
        raise ValidationError(f"{name}: no resistant-percentage rows recognised\n{inspect(data)}")

    rows: list[Observation] = []
    for (level, code, gname, year, organism, group), vals in sorted(cells.items()):
        if "pct" not in vals:
            skipped += 1                      # a denominator without a percentage is not an observation
            continue
        start, end = year_bounds(year)
        phenotype = PHENOTYPE_LABELS.get(group.lower(), "")
        n = vals.get("n")
        rows.append(Observation(
            source_id=SOURCE_ID, dataset=DATASET, release=retrieved_on, table_ref=f"Atlas CSV export {name}",
            source_url=SOURCE_URL, period_start=start, period_end=end, geo_level=level, geo_code=code, geo_name=gname,
            organism=organism, organism_src=organism, antimicrobial="" if phenotype else slug(group),
            antimicrobial_src=group, phenotype=phenotype, specimen="blood_csf",
            indicator="pct_resistant", value=vals["pct"], unit="% of tested isolates",
            denominator=int(n) if n is not None else None,
            breakpoint_standard=BREAKPOINTS, coverage_note=COVERAGE,
        ))
    return rows, skipped


def load(data: bytes, name: str, countries: tuple[str, ...] = DEFAULT_COUNTRIES, manifest: dict | None = None) -> Batch:
    sha = sha256_bytes(data)
    entry = check_manifest(name, sha, manifest if manifest is not None else read_manifest())
    retrieved_on = entry["retrieved_on"]
    rows, skipped = parse(data, name, retrieved_on, countries)
    retrieved_at = dt.datetime.fromisoformat(retrieved_on).replace(tzinfo=dt.UTC)
    return Batch(SOURCE_ID, DATASET, rows, SOURCE_URL, retrieved_at, skipped=skipped, input_name=name,
                 input_sha256=sha, notes=[entry.get("export_note", "")])

"""THL Finres report tables -> observations, read from the reviewed CSV in data/ (see finres_extract.py)."""

from __future__ import annotations

import csv
import datetime as dt
import json
from pathlib import Path

from pipeline.benchmarks.model import Observation, ValidationError, year_bounds
from pipeline.benchmarks.store import DATA_DIR, Batch, sha256_file

SOURCE_ID = "thl_finres"
DATASET = "finres"
PHENOTYPE_ROWS = {"ESBL": "ESBL", "MRSA": "MRSA"}   # rows that are shares of isolates with a phenotype, not an agent
DEDUP = ("First isolate per patient, per species and specimen type, per year (Finres methods; stated for most "
         "tables)")
BREAKPOINTS = "EUCAST, as interpreted by the reporting laboratories"
CIP_NOTE = "Ciprofloxacin results for 2017 and 2018 were recalculated by THL with the 2019 breakpoints."
BLOOD_COVERAGE_2024 = (
    "Blood-culture results in Finres covered 82% of tested blood isolates in 2024 (93% on average 2015-2024)."
)


def load(release: str = "2024", data_dir: Path = DATA_DIR) -> Batch:
    csv_path = data_dir / f"finres_{release}.csv"
    meta = json.loads((data_dir / f"finres_{release}.meta.json").read_text(encoding="utf-8"))
    if not meta.get("reviewed"):
        raise ValidationError(f"{csv_path.name} has not been reviewed against the report (meta reviewed=false)")
    retrieved_at = dt.datetime.fromisoformat(meta["retrieved_on"]).replace(tzinfo=dt.UTC)
    rows: list[Observation] = []
    skipped = 0
    with csv_path.open(newline="", encoding="utf-8") as fh:
        for line_no, r in enumerate(csv.DictReader(fh), start=2):
            if r["release"] != release:
                raise ValidationError(f"{csv_path.name} line {line_no}: release {r['release']!r} != {release!r}")
            if r["pct_resistant"] == "":
                skipped += 1
                continue
            code = r["antimicrobial_src"]
            year = int(r["year"])
            start, end = year_bounds(year)
            phenotype = PHENOTYPE_ROWS.get(code, "")
            notes = []
            if code == "CIP" and year in (2017, 2018):
                notes.append(CIP_NOTE)
            if r["specimen"] == "blood_csf" and year == 2024:
                notes.append(BLOOD_COVERAGE_2024)
            rows.append(Observation(
                source_id=SOURCE_ID, dataset=DATASET, release=release, table_ref=r["table_ref"],
                source_url=meta["source_url"], period_start=start, period_end=end,
                geo_level="country", geo_code="FI", geo_name="Finland",
                organism=r["organism"], organism_src=r["organism_src"],
                antimicrobial="" if phenotype else code, antimicrobial_src=code, phenotype=phenotype,
                specimen=r["specimen"], sex=r["sex"],
                indicator="pct_resistant", value=float(r["pct_resistant"]), unit="% of tested first isolates",
                denominator=int(r["n_tested"]),
                breakpoint_standard=BREAKPOINTS, dedup_rule=DEDUP, coverage_note=" ".join(notes) or None,
            ))
    batch = Batch(SOURCE_ID, DATASET, rows, meta["source_url"], retrieved_at, skipped=skipped,
                  input_name=csv_path.name, input_sha256=sha256_file(csv_path),
                  notes=[f"report PDF sha256 {meta['pdf_sha256']}"])
    return batch

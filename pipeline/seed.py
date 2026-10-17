"""Load the synthetic LIS export CSVs into staging.* (BUILD_PLAN.md §3.1). Run once.

    python -m pipeline.seed [--data-dir PATH]

Staging is truncated and reloaded, so re-running is safe. week_idx is computed here.
"""

from __future__ import annotations

import argparse
import logging
from pathlib import Path

import pandas as pd

from pipeline import config, db
from pipeline.weeks import week_idx_series

log = logging.getLogger(__name__)

STAGING_COLUMNS = {
    "patients": ["patient_id", "sex", "birth_year", "home_area"],
    "cultures": [
        "culture_id", "patient_id", "age_years", "sample_date", "iso_year", "iso_week", "week_idx",
        "ward_code", "ward_fi", "ward_en", "ward_type", "institution", "admission_date", "specimen",
        "specimen_fi", "result", "n_isolates",
    ],
    "isolates": ["isolate_id", "culture_id", "isolate_no", "organism", "quantity", "esbl", "mrsa", "vre", "cpe"],
    "susceptibility": [
        "isolate_id", "culture_id", "organism", "antibiotic", "antibiotic_code", "antibiotic_fi",
        "result", "guideline",
    ],
}


def read_csvs(data_dir: Path) -> dict[str, pd.DataFrame]:
    frames = {name: pd.read_csv(data_dir / f"{name}.csv", dtype=str, keep_default_na=False, na_values=[""])
              for name in config.CSV_FILES}
    cu = frames["cultures"]
    cu["week_idx"] = week_idx_series(cu["iso_year"].astype(int), cu["iso_week"].astype(int))
    return frames


def seed(conn, data_dir: Path) -> dict[str, int]:
    frames = read_csvs(data_dir)
    counts = {}
    with conn.cursor() as cur:
        cur.execute("truncate staging.susceptibility, staging.isolates, staging.cultures, staging.patients")
    for name in ("patients", "cultures", "isolates", "susceptibility"):
        db.copy_df(conn, f"staging.{name}", frames[name], STAGING_COLUMNS[name])
        counts[name] = len(frames[name])
        log.info("staging.%s: %d rows", name, counts[name])
    conn.commit()
    return counts


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--data-dir", type=Path, default=None)
    args = ap.parse_args()
    data_dir = args.data_dir or config.data_dir()
    with db.connect(config.db_url()) as conn:
        print(seed(conn, data_dir))


if __name__ == "__main__":
    main()

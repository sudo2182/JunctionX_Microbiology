from pathlib import Path

import pandas as pd
import pytest

from pipeline.clean import RawBatch, clean_batch
from pipeline.weeks import week_idx_series

FIXTURES = Path(__file__).resolve().parents[2] / "data" / "fixtures"


def read_raw(data_dir: Path) -> RawBatch:
    cu = pd.read_csv(data_dir / "cultures.csv")
    cu["week_idx"] = week_idx_series(cu["iso_year"], cu["iso_week"])
    return RawBatch(
        cultures=cu,
        isolates=pd.read_csv(data_dir / "isolates.csv"),
        susceptibility=pd.read_csv(data_dir / "susceptibility.csv"),
        patients=pd.read_csv(data_dir / "patients.csv"),
    )


def lab_isolates(batch) -> pd.DataFrame:
    """Isolates joined to culture context, the shape aggregate.compute_rates expects."""
    ctx = batch.cultures[["culture_id", "patient_id", "specimen", "sample_date", "week_idx",
                          "ward_code", "setting", "onset"]]
    return batch.isolates.merge(ctx, on="culture_id")


@pytest.fixture
def raw() -> RawBatch:
    return read_raw(FIXTURES)


@pytest.fixture
def batch(raw):
    return clean_batch(raw)

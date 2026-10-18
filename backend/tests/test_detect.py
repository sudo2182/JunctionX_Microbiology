"""pipeline.detect: the database frames must feed the engine exactly like the CSV loader does."""

import pandas as pd
import pytest

from pipeline.anomaly import Engine
from pipeline.anomaly.data import load_csv_dir
from pipeline.clean import clean_batch
from pipeline.config import data_dir
from pipeline.detect import engine_frames
from tests.conftest import lab_isolates, read_raw

OUTBREAK_WEEK = 88  # 2025-W23, Urology ESBL E. coli (pipeline/anomaly/README.md)


@pytest.fixture(scope="module")
def real_frames():
    path = data_dir()
    if not (path / "cultures.csv").exists():
        pytest.skip("synthetic dataset not found")
    batch = clean_batch(read_raw(path))
    iso = lab_isolates(batch)
    ast = batch.susceptibility
    return path, iso, ast


def test_engine_frames_have_the_engine_columns(real_frames):
    _, iso, ast = real_frames
    isolates, markers = engine_frames(iso, ast)
    assert list(markers.columns) == ["isolate_id", "marker", "resistant"]
    assert isolates["isolate_id"].is_unique
    assert set(markers["marker"]) >= {"ESBL", "MRSA", "VRE", "CPE", "CIP"}
    assert markers["resistant"].dtype == bool


def test_intrinsic_and_non_reportable_results_are_not_given_to_the_engine(real_frames):
    _, iso, ast = real_frames
    _, markers = engine_frames(iso, ast)
    excluded = ast[ast["is_intrinsic"] | ~ast["reportable"]]
    assert len(excluded) > 0
    pairs = set(zip(markers["isolate_id"], markers["marker"], strict=True))
    assert not pairs & set(zip(excluded["isolate_id"], excluded["antibiotic_code"], strict=True))


def test_database_path_finds_the_same_alerts_as_the_csv_path(real_frames):
    path, iso, ast = real_frames
    from_csv = Engine(*load_csv_dir(path)).detect_week(OUTBREAK_WEEK)
    from_lab = Engine(*engine_frames(iso, ast)).detect_week(OUTBREAK_WEEK)
    assert from_csv, "the planted outbreak week should raise alerts"
    assert [a.key for a in from_lab] == [a.key for a in from_csv]
    pd.testing.assert_series_equal(
        pd.Series([a.rank for a in from_lab]), pd.Series([a.rank for a in from_csv]), check_exact=False
    )

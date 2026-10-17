import pytest

from pipeline.weeks import week_idx, week_label


@pytest.mark.parametrize(
    "year,week,idx",
    [(2023, 40, 1), (2024, 40, 53), (2024, 43, 56), (2025, 20, 85), (2025, 23, 88), (2026, 10, 127), (2026, 39, 156)],
)
def test_week_idx_matches_plan(year, week, idx):
    assert week_idx(year, week) == idx
    assert week_label(idx) == f"{year}-W{week:02d}"

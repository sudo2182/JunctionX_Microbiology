"""ISO-week indexing for the 156-week replay (BUILD_PLAN.md §3.1).

week_idx 1 = 2023-W40 (Monday 2023-10-02), 53 = 2024-W40, 88 = 2025-W23, 127 = 2026-W10,
156 = 2026-W39. Mirrored in SQL as ref.week_start() / ref.week_label().
"""

from __future__ import annotations

from datetime import date, timedelta

import pandas as pd

FIRST_MONDAY = date(2023, 10, 2)
LAST_WEEK_IDX = 156


def week_idx(iso_year: int, iso_week: int) -> int:
    monday = date.fromisocalendar(int(iso_year), int(iso_week), 1)
    return (monday - FIRST_MONDAY).days // 7 + 1


def week_idx_series(iso_year: pd.Series, iso_week: pd.Series) -> pd.Series:
    pairs = pd.DataFrame({"y": iso_year.astype(int), "w": iso_week.astype(int)})
    lookup = {(y, w): week_idx(y, w) for y, w in pairs.drop_duplicates().itertuples(index=False)}
    return pd.Series(
        [lookup[(y, w)] for y, w in pairs.itertuples(index=False)], index=iso_year.index, dtype="int64"
    )


def week_start(idx: int) -> date:
    return FIRST_MONDAY + timedelta(weeks=idx - 1)


def week_label(idx: int) -> str:
    y, w, _ = week_start(idx).isocalendar()
    return f"{y}-W{w:02d}"

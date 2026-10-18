"""Replay week index <-> ISO week label. week_idx 1 is 2023-W40 (Monday 2023-10-02)."""

from __future__ import annotations

import datetime as dt

WEEK1_MONDAY = dt.date(2023, 10, 2)


def week_monday(week_idx: int) -> dt.date:
    return WEEK1_MONDAY + dt.timedelta(weeks=week_idx - 1)


def week_label(week_idx: int) -> str:
    """week_label(88) -> '2025-W23'."""
    year, week, _ = week_monday(week_idx).isocalendar()
    return f"{year}-W{week:02d}"


def week_idx_from_label(label: str) -> int:
    year, week = label.split("-W")
    monday = dt.date.fromisocalendar(int(year), int(week), 1)
    return (monday - WEEK1_MONDAY).days // 7 + 1

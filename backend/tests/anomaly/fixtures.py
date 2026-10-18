"""Tiny hand-built hospitals for engine unit tests."""

from __future__ import annotations

import datetime as dt
import itertools

import pandas as pd

from pipeline.anomaly.data import ISOLATE_COLUMNS, MARKER_COLUMNS, WEEK1_MONDAY


class Lab:
    def __init__(self) -> None:
        self.isolates: list[dict] = []
        self.markers: list[dict] = []
        self._ids = itertools.count(1)
        self._patients = itertools.count(1)

    def patient(self) -> str:
        return f"P{next(self._patients):05d}"

    def add(
        self,
        week: int,
        *,
        patient: str | None = None,
        organism: str = "Escherichia coli",
        specimen: str = "urine",
        ward: str = "URO",
        setting: str = "inpatient",
        onset: str = "hospital",
        day: int = 0,
        **markers: bool,
    ) -> str:
        iid = f"I{next(self._ids):06d}"
        self.isolates.append(
            {
                "isolate_id": iid,
                "patient_id": patient or self.patient(),
                "week_idx": week,
                "sample_date": pd.Timestamp(WEEK1_MONDAY + dt.timedelta(weeks=week - 1, days=day)),
                "organism": organism,
                "specimen": specimen,
                "ward_code": ward,
                "setting": setting,
                "onset": onset,
            }
        )
        for marker, resistant in markers.items():
            self.markers.append({"isolate_id": iid, "marker": marker, "resistant": resistant})
        return iid

    def frames(self) -> tuple[pd.DataFrame, pd.DataFrame]:
        return pd.DataFrame(self.isolates, columns=ISOLATE_COLUMNS), pd.DataFrame(self.markers, columns=MARKER_COLUMNS)


def steady_ecoli(lab: Lab, weeks: range, per_week: int, resistant_every: int, ward: str = "URO") -> None:
    """per_week distinct-patient E. coli urine isolates, every n-th one CIP-resistant."""
    k = 0
    for w in weeks:
        for _ in range(per_week):
            k += 1
            lab.add(w, ward=ward, CIP=(k % resistant_every == 0), ESBL=False)

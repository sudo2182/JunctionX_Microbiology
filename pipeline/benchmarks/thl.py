"""THL (Finres / national AMR statistics), Finland.

THL publishes annual %R in the Finres report; the open data cubes on sampo.thl.fi (the
infectious disease register) carry notified case counts (MRSA, ESBL, CPE, VRE), not %R.
So the route is the Finres tables transcribed into raw/thl_finres_<year>.csv in the tidy
format of tabular.py. Urinary E. coli rows are the best comparator for our urine data.
"""

from __future__ import annotations

from pipeline.benchmarks import tabular
from pipeline.benchmarks.model import BenchRow

SOURCE = "thl"
SOURCE_URL = "https://thl.fi/en/topics/infectious-diseases-and-vaccinations/surveillance-and-registers/finres"


def parse(text: str) -> list[BenchRow]:
    return tabular.parse(text, SOURCE, SOURCE_URL)

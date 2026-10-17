"""WHO GLASS: global context rates.

Route: the GLASS dashboard's own data download or the GLASS report annex, saved as CSV in
raw/glass_<date>.csv. Do not scrape the Shiny app (session tokens in its URL). Column
names from the download are mapped through tabular.ALIASES; check them on first use.
"""

from __future__ import annotations

from pipeline.benchmarks import tabular
from pipeline.benchmarks.model import BenchRow

SOURCE = "glass"
SOURCE_URL = "https://www.who.int/initiatives/glass"


def parse(text: str) -> list[BenchRow]:
    return tabular.parse(text, SOURCE, SOURCE_URL)

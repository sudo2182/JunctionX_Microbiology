import csv
from pathlib import Path

import pytest

from pipeline.benchmarks import finres, finres_extract
from pipeline.benchmarks.finres_extract import ExtractError, TableSpec
from pipeline.benchmarks.model import ValidationError, validate
from pipeline.benchmarks.store import DATA_DIR

# Lines as they appear in the Finres 2024 report (THL Työpaperi 47/2025), tables 7 and 11.
T11_PAGE = """
Mikrobilääke 2015 2016 2017 2018 2019 2020 2021 2022 2023 2024
TMP Testatut (n) 120735 124569 126543 113900 118379 109741 95410 80344 70884 79749
R % 18,4 18,6 18,5 17,8 18,7 17,7 16,2 15,6 16,0 17,6
NIT Testatut (n) 116527 120280 122875 110171 108587 101709 91886 76358 67578 75341
R % 0,9 0,7 0,7 0,6 0,6 0,5 0,5 0,5 0,4 0,5
"""
T11 = TableSpec(11, 26, "Escherichia coli", "code", "urine", "female", frozenset({"TMP", "NIT"}))


def test_table_rows_are_read_with_counts_and_percentages():
    rows = finres_extract.parse_page(T11_PAGE, T11)
    tmp = [r for r in rows if r["label"] == "TMP"]
    assert [r["year"] for r in tmp] == list(range(2015, 2025))
    assert (tmp[-1]["n_tested"], tmp[-1]["pct"]) == (79749, 17.6)
    csv_rows = finres_extract.to_csv_rows("2024", T11, rows)
    assert csv_rows[0]["sex"] == "female" and csv_rows[0]["table_ref"] == "Taulukko 11, p. 26"


def test_unexpected_or_missing_rows_are_refused():
    with pytest.raises(ExtractError, match="found rows"):
        finres_extract.parse_page(T11_PAGE, TableSpec(11, 26, "Escherichia coli", "code", "urine", "female",
                                                      frozenset({"TMP", "NIT", "CIP"})))
    with pytest.raises(ExtractError, match="year header"):
        finres_extract.parse_page(T11_PAGE.replace("2015 2016", "2014 2016"), T11)


def test_star_cells_have_no_percentage():
    page = T11_PAGE.replace("R % 18,4 18,6", "R % * 18,6")
    first = finres_extract.parse_page(page, T11)[0]
    assert first["pct"] is None and "no percentage published" in first["note"]


def test_percent_count_mismatch_is_refused():
    with pytest.raises(ExtractError, match="expected 10 percentages"):
        finres_extract.parse_page(T11_PAGE.replace("R % 18,4 18,6", "R % 18,6"), T11)


def _word(text, x0, x1, top=100.0):
    return {"text": text, "x0": x0, "x1": x1, "top": top}


def test_thousands_space_is_told_apart_from_a_column_gap():
    # Geometry of the report's table 7 row 'Märkä AMP', 2015-2016: "3 543" and "3 287" are one number each (gap
    # 2.2 pt), while "1 158" and "911" are separate columns (gap 7.7 pt after a 3-digit number).
    words = [_word("Testatut", 234.7, 263.5), _word("(n)", 265.7, 275.6),
             _word("3", 286.9, 291.4), _word("543", 293.6, 306.9), _word("3", 318.6, 323.0), _word("287", 325.2, 338.5),
             _word("1", 484.8, 489.2), _word("158", 491.4, 504.8), _word("911", 512.5, 525.8),
             _word("730", 540.2, 553.5)]
    assert finres_extract.page_lines(words) == ["Testatut (n) 3543 3287 1158 911 730"]


def test_committed_csv_matches_the_report():
    batch = finres.load("2024")
    validate(batch.rows)
    assert len(batch.rows) == 585 and batch.skipped == 5          # 590 cells, 5 printed as '*' in the report
    by = {(r.table_ref.split(",")[0], r.antimicrobial_src, r.sex, r.specimen, r.period_start.year): r
          for r in batch.rows}
    tmp = by[("Taulukko 11", "TMP", "female", "urine", 2024)]
    assert (tmp.value, tmp.denominator, tmp.sex) == (17.6, 79749, "female")
    assert by[("Taulukko 12", "CIP", "male", "urine", 2024)].value == 11.3
    esbl = by[("Taulukko 13", "ESBL", "female", "urine", 2024)]
    assert (esbl.value, esbl.denominator, esbl.phenotype, esbl.antimicrobial) == (2.8, 79756, "ESBL", "")
    mrsa = by[("Taulukko 35", "MRSA", "all", "blood_csf", 2024)]
    assert (mrsa.value, mrsa.denominator, mrsa.phenotype) == (3.6, 2272, "MRSA")
    assert "82%" in by[("Taulukko 10", "CIP", "all", "blood_csf", 2024)].coverage_note
    assert "2019 breakpoints" in by[("Taulukko 10", "CIP", "all", "blood_csf", 2018)].coverage_note
    assert ("Taulukko 35", "TOB", "all", "blood_csf", 2023) not in by       # '*' in the report: no value invented
    assert all(r.numerator is None and r.ci_low is None for r in batch.rows)   # not published, not derived
    assert len(batch.input_sha256) == 64


def test_unreviewed_csv_is_refused(tmp_path):
    for name in ("finres_2024.csv", "finres_2024.meta.json"):
        (tmp_path / name).write_bytes((DATA_DIR / name).read_bytes())
    meta = tmp_path / "finres_2024.meta.json"
    meta.write_text(meta.read_text().replace('"reviewed": true', '"reviewed": false'))
    with pytest.raises(ValidationError, match="not been reviewed"):
        finres.load("2024", data_dir=tmp_path)


def test_every_finres_row_has_the_columns_the_importer_reads():
    with (DATA_DIR / "finres_2024.csv").open(newline="", encoding="utf-8") as fh:
        assert set(next(csv.reader(fh))) == set(finres_extract.CSV_COLUMNS)
    assert Path(DATA_DIR / "finres_2024.meta.json").exists()

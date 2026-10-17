"""Finres report PDF -> data/finres_<release>.csv. A developer tool, run once per annual report.

    python -m pipeline.benchmarks.finres_extract --pdf Finres2024.pdf --release 2024

The report's tables are published as PDF only. This script reads the text layer of the tables listed in TABLES,
refuses anything that does not match what the table is expected to contain, and writes a long-format CSV that a
person then reviews against the PDF before committing. The PDF itself is not committed (CC BY-NC-ND); its
SHA-256 goes into the sidecar file data/finres_<release>.meta.json so the source is identifiable.

Needs pdfplumber (in requirements-dev.txt); the importer itself does not. Word positions are used because some
tables write thousands with a space ("15 068"), which the plain text layer cannot tell from two columns.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path

from pipeline.benchmarks.store import DATA_DIR, sha256_file

YEARS = list(range(2015, 2025))
SPECIMEN_FI = {"Veri": "blood_csf", "Virtsa": "urine", "Märkä": "pus"}
SEX_FI = {"Naiset": "female", "Miehet": "male"}
CSV_COLUMNS = ["release", "table_ref", "organism", "organism_src", "specimen", "sex", "antimicrobial_src",
               "year", "n_tested", "pct_resistant", "note"]


@dataclass(frozen=True)
class TableSpec:
    number: int
    page: int                      # 1-based page of the PDF that holds the table's rows
    organism: str
    layout: str                    # 'code' | 'specimen_code' | 'sex' | 'specimen'
    specimen: str | None = None    # fixed specimen for 'code' and 'sex' layouts
    sex: str = "all"
    expect: frozenset = frozenset()  # row labels the table must contain, checked exactly


def _codes(s: str) -> frozenset:
    return frozenset(s.split())


TABLES = (
    TableSpec(7, 23, "Enterococcus faecalis", "specimen_code",
              expect=frozenset({"Veri AMP", "Virtsa AMP", "Virtsa NIT", "Märkä AMP"})),
    TableSpec(10, 25, "Escherichia coli", "code", "blood_csf", expect=_codes("TZP TOB MEM ESBL CXM CRO CIP CAZ")),
    TableSpec(11, 26, "Escherichia coli", "code", "urine", "female", _codes("TMP NIT MEC LEX CXM CIP")),
    TableSpec(12, 27, "Escherichia coli", "code", "urine", "male", _codes("TMP NIT MEC LEX CXM CIP")),
    TableSpec(13, 28, "Escherichia coli", "sex", "urine", expect=frozenset({"Naiset", "Miehet"})),
    TableSpec(20, 36, "Klebsiella pneumoniae", "code", "blood_csf",
              expect=_codes("TZP TOB MEM ESBL CXM CRO CIP CAZ")),
    TableSpec(21, 37, "Klebsiella pneumoniae", "code", "urine", expect=_codes("TMP MEC LEX CXM CIP")),
    TableSpec(22, 38, "Klebsiella pneumoniae", "specimen", expect=frozenset({"Virtsa", "Veri"})),
    TableSpec(30, 47, "Pseudomonas aeruginosa", "code", "blood_csf", expect=_codes("TZP TOB MEM CIP CAZ")),
    TableSpec(31, 48, "Pseudomonas aeruginosa", "code", "urine", expect=_codes("TZP TOB MEM CIP CAZ")),
    TableSpec(35, 53, "Staphylococcus aureus", "code", "blood_csf", expect=_codes("TOB TCY SXT RIF MRSA LVX ERY CLI")),
)

_N_LINE = re.compile(
    r"^(?:(?P<lead>Veri|Virtsa|Märkä|Naiset|Miehet)\s+)?(?:(?P<code>[A-Z]{3,4})\*{0,2}\s+)?"
    r"Testatut \(n\)\s+(?P<vals>.+)$"
)
_R_LINE = re.compile(r"^(?:R|ESBL) %\s+(?P<vals>.+)$")
_YEAR_HEADER = re.compile(r"^(?:\w+\s+)?(?:Mikrobilääke|Sukupuoli|Näytelaatu)\s+(?P<years>(?:\d{4}\s*)+)$")


class ExtractError(ValueError):
    pass


def parse_counts(text: str, n: int = len(YEARS)) -> list[int]:
    toks = text.split()
    if len(toks) != n or not all(t.isdigit() for t in toks):
        raise ExtractError(f"expected {n} whole numbers, found {text!r}")
    return [int(t) for t in toks]


def parse_percents(text: str, n: int = len(YEARS)) -> list[tuple[float | None, str]]:
    toks = text.split()
    if len(toks) != n:
        raise ExtractError(f"expected {n} percentages, found {len(toks)}: {text!r}")
    out = []
    for t in toks:
        if re.fullmatch(r"\d+(,\d+)?", t):
            out.append((float(t.replace(",", ".")), ""))
        else:
            out.append((None, f"source cell shows {t!r}, no percentage published"))
    return out


def parse_page(text: str, spec: TableSpec) -> list[dict]:
    """Rows of one table from the text of its page."""
    lines = [ln.strip() for ln in text.splitlines()]
    header_years = [list(map(int, m.group("years").split())) for ln in lines if (m := _YEAR_HEADER.match(ln))]
    if not header_years or any(h != YEARS for h in header_years[:1]):
        raise ExtractError(f"table {spec.number}: year header 2015-2024 not found on page {spec.page}")
    rows, seen = [], set()
    for i, ln in enumerate(lines[:-1]):
        m = _N_LINE.match(ln)
        nxt = _R_LINE.match(lines[i + 1])
        if not m or not nxt:
            continue
        lead, code = m.group("lead"), m.group("code")
        label = " ".join(x for x in (lead, code) if x) or ""
        if label not in spec.expect:
            continue
        counts = parse_counts(m.group("vals"))
        pcts = parse_percents(nxt.group("vals"))
        seen.add(label)
        for year, n_tested, (pct, note) in zip(YEARS, counts, pcts):
            rows.append({"label": label, "lead": lead, "code": code, "year": year, "n_tested": n_tested,
                         "pct": pct, "note": note})
    if seen != set(spec.expect):
        raise ExtractError(f"table {spec.number}: found rows {sorted(seen)}, expected {sorted(spec.expect)}")
    return rows


def to_csv_rows(release: str, spec: TableSpec, parsed: list[dict]) -> list[dict]:
    out = []
    for r in parsed:
        specimen, sex = spec.specimen, spec.sex
        if spec.layout in ("specimen_code", "specimen"):
            specimen = SPECIMEN_FI[r["lead"]]
        if spec.layout == "sex":
            sex = SEX_FI[r["lead"]]
        src = r["code"] or "ESBL"          # tables 13 and 22 give the ESBL share without a code
        out.append({
            "release": release, "table_ref": f"Taulukko {spec.number}, p. {spec.page}", "organism": spec.organism,
            "organism_src": spec.organism, "specimen": specimen, "sex": sex, "antimicrobial_src": src,
            "year": r["year"], "n_tested": r["n_tested"], "pct_resistant": "" if r["pct"] is None else r["pct"],
            "note": r["note"],
        })
    return out


THOUSANDS_GAP = (1.9, 2.6)   # points between "15" and "068"; column gaps in these tables are never this size


def page_lines(words: list[dict]) -> list[str]:
    """Words with positions -> text lines, fusing '15' + '068' into '15068' when the gap is a thousands space."""
    rows: dict[float, list[dict]] = {}
    for w in sorted(words, key=lambda w: w["top"]):
        key = next((k for k in rows if abs(k - w["top"]) < 2), w["top"])
        rows.setdefault(key, []).append(w)
    lines = []
    for _, ws in sorted(rows.items()):
        ws.sort(key=lambda w: w["x0"])
        parts: list[str] = []
        prev = None
        for w in ws:
            t = w["text"]
            fuse = (prev is not None and prev["text"].isdigit() and len(prev["text"]) <= 3 and t.isdigit()
                    and len(t) == 3 and THOUSANDS_GAP[0] <= w["x0"] - prev["x1"] <= THOUSANDS_GAP[1])
            if fuse:
                parts[-1] += t
            else:
                parts.append(t)
            prev = w
        lines.append(" ".join(parts))
    return lines


def extract(pdf: Path, release: str) -> list[dict]:
    try:
        import pdfplumber
    except ImportError:
        sys.exit("pdfplumber is needed for this developer tool: pip install -r requirements-dev.txt")
    rows: list[dict] = []
    with pdfplumber.open(str(pdf)) as doc:
        for spec in TABLES:
            words = doc.pages[spec.page - 1].extract_words(x_tolerance=1.5)
            rows += to_csv_rows(release, spec, parse_page("\n".join(page_lines(words)), spec))
    return rows


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--pdf", type=Path, required=True)
    ap.add_argument("--release", required=True, help="report edition, e.g. 2024")
    ap.add_argument("--pdf-url", default="https://www.julkari.fi/bitstreams/4b06f80d-cdde-422c-a33a-c1cd75e1f806/download")
    ap.add_argument("--retrieved-on", default=dt.datetime.now(dt.UTC).date().isoformat(),
                    help="date the PDF was downloaded")
    ap.add_argument("--out-dir", type=Path, default=DATA_DIR)
    args = ap.parse_args(argv)
    rows = extract(args.pdf, args.release)
    args.out_dir.mkdir(parents=True, exist_ok=True)
    csv_path = args.out_dir / f"finres_{args.release}.csv"
    with csv_path.open("w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=CSV_COLUMNS)
        w.writeheader()
        w.writerows(rows)
    meta = {
        "release": args.release,
        "report": "Bakteerien mikrobilääkeresistenssi Suomessa: Finres " + args.release,
        "source_url": "https://urn.fi/URN:ISBN:978-952-408-596-0",
        "pdf_url": args.pdf_url,
        "pdf_sha256": sha256_file(args.pdf),
        "retrieved_on": args.retrieved_on,
        "extracted_by": "pipeline.benchmarks.finres_extract",
        "reviewed": False,
    }
    (args.out_dir / f"finres_{args.release}.meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(rows)} rows to {csv_path}; review them against the PDF, then set reviewed=true in the meta file")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

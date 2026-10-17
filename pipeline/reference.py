"""Reference sets used by the cleaning and aggregation rules.

The defaults mirror the rows seeded in supabase/migrations/*_ref.sql so pure functions and tests run
without a database. At run time `pipeline.db.load_reference()` reads the same sets from `ref.*`.
"""

from __future__ import annotations

from dataclasses import dataclass, field

ENTEROBACTERALES = (
    "Escherichia coli",
    "Klebsiella pneumoniae",
    "Klebsiella oxytoca",
    "Proteus mirabilis",
    "Citrobacter freundii",
)

DEFAULT_ORGANISMS = frozenset(
    ENTEROBACTERALES
    + (
        "Pseudomonas aeruginosa",
        "Staphylococcus aureus",
        "Staphylococcus saprophyticus",
        "Enterococcus faecalis",
    )
)

DEFAULT_ANTIBIOTICS = frozenset(
    ["AMP", "MEC", "TZP", "FOX", "CXM", "CRO", "CAZ", "MEM", "CIP", "TMP", "NIT", "VAN", "CLI"]
)

# antibiotics.csv reported_for == 'urine'
DEFAULT_URINE_ONLY = frozenset(["MEC", "TMP", "NIT"])

# EUCAST Expected Resistant Phenotypes v1.2, the pairs present in the dataset (all 100% R).
DEFAULT_INTRINSIC = frozenset(
    [
        ("Klebsiella pneumoniae", "AMP"),
        ("Klebsiella oxytoca", "AMP"),
        ("Citrobacter freundii", "AMP"),
        ("Proteus mirabilis", "NIT"),
    ]
)

# Phenotype marker -> (isolate flag column, organisms it is reported for).
DEFAULT_PHENOTYPES = {
    "ESBL": ("esbl", ("Escherichia coli", "Klebsiella pneumoniae")),
    "MRSA": ("mrsa", ("Staphylococcus aureus",)),
    "VRE": ("vre", ("Enterococcus faecalis",)),
    "CPE": ("cpe", ENTEROBACTERALES),
}

DEFAULT_WARDS = frozenset(["ED", "MED-A", "MED-B", "SURG", "URO", "ICU", "GER", "PHC-N", "PHC-S"])


@dataclass(frozen=True)
class Reference:
    organisms: frozenset = DEFAULT_ORGANISMS
    antibiotics: frozenset = DEFAULT_ANTIBIOTICS
    urine_only: frozenset = DEFAULT_URINE_ONLY
    intrinsic: frozenset = DEFAULT_INTRINSIC
    wards: frozenset = DEFAULT_WARDS
    phenotypes: dict = field(default_factory=lambda: dict(DEFAULT_PHENOTYPES))

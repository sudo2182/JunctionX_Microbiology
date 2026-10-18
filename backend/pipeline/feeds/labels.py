"""Display names used in feed titles. Defaults mirror ref.wards / ref.antibiotics."""

from __future__ import annotations

import re

WARDS = {
    "ED": "Emergency department",
    "MED-A": "Internal medicine A",
    "MED-B": "Internal medicine B",
    "SURG": "Surgery",
    "URO": "Urology",
    "ICU": "Intensive care unit",
    "GER": "Geriatrics",
    "PHC-N": "Health centre North",
    "PHC-S": "Health centre South",
}

SETTINGS = {"inpatient": "Inpatients", "ed": "Emergency department", "primary_care": "Primary care"}

ONSETS = {"hospital": "Hospital-onset", "community": "Community-onset", "outpatient": "Outpatients"}

ANTIBIOTICS = {
    "AMP": "ampicillin",
    "MEC": "mecillinam",
    "TZP": "piperacillin-tazobactam",
    "FOX": "cefoxitin",
    "CXM": "cefuroxime",
    "CRO": "ceftriaxone",
    "CAZ": "ceftazidime",
    "MEM": "meropenem",
    "CIP": "ciprofloxacin",
    "TMP": "trimethoprim",
    "NIT": "nitrofurantoin",
    "VAN": "vancomycin",
    "CLI": "clindamycin",
}

ORGANISMS = [
    "Escherichia coli",
    "Staphylococcus aureus",
    "Enterococcus faecalis",
    "Klebsiella pneumoniae",
    "Proteus mirabilis",
    "Pseudomonas aeruginosa",
    "Citrobacter freundii",
    "Klebsiella oxytoca",
    "Staphylococcus saprophyticus",
]

PHENOTYPES = ["ESBL", "MRSA", "VRE", "CPE"]


def short_organism(name: str) -> str:
    """'Escherichia coli' -> 'E. coli'."""
    parts = name.split()
    if len(parts) >= 2 and parts[0][:1].isupper():
        return f"{parts[0][0]}. {' '.join(parts[1:])}"
    return name


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def scope_label(scope_type: str, scope_value: str, wards: dict[str, str] | None = None) -> str:
    wards = wards or WARDS
    if scope_type == "ward":
        return wards.get(scope_value, scope_value)
    if scope_type == "setting":
        return SETTINGS.get(scope_value, scope_value)
    if scope_type == "onset":
        return ONSETS.get(scope_value, scope_value)
    return "Hospital-wide"

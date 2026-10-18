"""Alert rules and clinical reference lists for the anomaly engine (BUILD_PLAN §7).

These are the frozen thresholds the ground-truth test guards. When `ref.alert_rules`
exists in Supabase, its row can be loaded into `Rules` instead of the defaults.
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
ENTEROCOCCI = ("Enterococcus faecalis",)

PHENOTYPES = ("ESBL", "MRSA", "VRE", "CPE")

# Phenotype shares monitored as rate signals (marker, organisms it is a share of).
PHENOTYPE_RATES = {
    "ESBL": ("Escherichia coli", "Klebsiella pneumoniae"),
    "MRSA": ("Staphylococcus aureus",),
}

# Antibiotics skipped as rate signals because a phenotype marker already covers them.
REDUNDANT_AGENTS = {("Staphylococcus aureus", "FOX")}  # cefoxitin screen == MRSA flag

# EUCAST expected resistant phenotypes present in the data (always 100% R). These are
# also flagged by the cleaning step; the engine drops them again so it is safe on raw input.
INTRINSIC_RESISTANCE = {
    ("Klebsiella pneumoniae", "AMP"),
    ("Klebsiella oxytoca", "AMP"),
    ("Citrobacter freundii", "AMP"),
    ("Proteus mirabilis", "NIT"),
}
URINE_ONLY_AGENTS = {"MEC", "TMP", "NIT"}


@dataclass(frozen=True)
class CountRule:
    name: str
    marker: str
    organisms: tuple[str, ...]
    sentinel: bool = False  # any single isolate fires immediately
    sentinel_specimen: str | None = None  # restrict the sentinel to one specimen


COUNT_RULES = (
    CountRule("MRSA", "MRSA", ("Staphylococcus aureus",)),
    CountRule("ESBL", "ESBL", ENTEROBACTERALES),
    CountRule("3GC-R Enterobacterales", "CRO", ENTEROBACTERALES),
    CountRule("CPE", "CPE", ENTEROBACTERALES, sentinel=True),
    CountRule("VRE", "VRE", ENTEROCOCCI, sentinel=True),
    CountRule("Carbapenem-R Enterobacterales", "MEM", ENTEROBACTERALES, sentinel=True),
    CountRule("Blood MRSA", "MRSA", ("Staphylococcus aureus",), sentinel=True, sentinel_specimen="blood"),
)

# Severity inputs (§7.5)
PRIORITY_MARKERS = {"ESBL", "MRSA", "VRE", "CPE"}
PRIORITY_AGENTS = {  # agent results that are a priority phenotype for these organisms
    "MEM": ENTEROBACTERALES,
    "CRO": ENTEROBACTERALES,
    "CAZ": ENTEROBACTERALES,
    "VAN": ENTEROCOCCI + ("Staphylococcus aureus",),
}
FIRST_LINE_AGENTS = {"urine": {"TMP", "MEC", "NIT"}, "blood": {"CRO"}}

# Agents shown as co-resistance in the explanation of a phenotype alert.
CO_RESISTANCE_AGENTS = ("CIP", "TMP", "CRO", "TZP", "MEM", "CLI")

CONFIDENCE_WEIGHT = {"high": 1.0, "medium": 0.7, "low": 0.4}


def severity_band(points: int) -> str:
    if points >= 7:
        return "critical"
    if points >= 5:
        return "high"
    if points >= 3:
        return "medium"
    return "low"


@dataclass(frozen=True)
class Rules:
    current_weeks: int = 4
    widen_to: tuple[int, ...] = (8, 13)
    baseline_weeks: int = 52
    min_n: int = 30
    # rate signal
    zero_floor_numerator: float = 0.5  # p0 floored at 0.5 / n_baseline
    min_abs_pp: float = 5.0
    min_ratio: float = 1.5
    q_threshold: float = 0.05
    weekly_combos: tuple[tuple[str, str], ...] = (("Escherichia coli", "urine"),)
    # count signal
    count_lambda_floor: float = 0.5
    count_p_threshold: float = 0.01
    count_min_k: int = 3
    # drift signal: Cochran-Armitage trend over 13-week blocks of all released history
    drift_block_weeks: int = 13
    drift_min_blocks: int = 8
    drift_max_blocks: int = 12
    drift_q_threshold: float = 0.001
    drift_min_pp_per_year: float = 1.0
    drift_every_weeks: int = 4
    # episodes
    resolve_after_quiet_weeks: int = 2
    scopes: tuple[str, ...] = field(default=("hospital", "ward", "setting", "onset"))

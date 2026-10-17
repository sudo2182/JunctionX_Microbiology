"""Configurable relevance filter for antimicrobial-resistance (AMR) announcements.

Categorizes announcements into:
1. 'relevant': Definite high-confidence AMR surveillance reports, guidance, or alerts.
2. 'review': Broader healthcare-associated infection (HAI) or critical pathogen reports needing clinical review.
3. 'unrelated': Announcements outside the AMR surveillance domain (e.g., dengue, mpox, avian influenza).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum


class RelevanceCategory(StrEnum):
    RELEVANT = "relevant"
    REVIEW = "review"
    UNRELATED = "unrelated"


@dataclass(frozen=True)
class Rule:
    pattern: re.Pattern
    label: str
    weight: int = 10


# Rules are (regex, label). Matching is case-insensitive, except acronyms wrapped in (?-i:...), which must be
# upper case so that names and ordinary words ("Amr", "Caesar", "cre") do not match. "_" stands for one or more
# spaces or hyphens, so "antimicrobial resistance", "antimicrobial-resistance" and line-wrapped text all match.
_ = r"[\s\-\u2010\u2011]+"

# Tier 1 -> 'relevant': explicit AMR surveillance, phenotype and resistance terms.
TIER_1_PATTERNS = [
    (rf"\bantimicrobial{_}resistan(ce|t)\b", "antimicrobial resistance"),
    (rf"\bantibiotic{_}resistan(ce|t)\b", "antibiotic resistance"),
    (r"(?-i:\bAMR\b)", "AMR"),
    (rf"\bantimicrobial{_}susceptibility\b", "antimicrobial susceptibility"),
    (rf"\bresistant{_}bacteri(a|um)\b", "resistant bacteria"),
    (rf"\b(multi(?:{_})?drug|multi)(?:{_})?resistan(t|ce)\b", "multidrug-resistant"),
    (r"(?-i:\bMDROs?\b)", "MDRO"),
    (rf"\bcarbapenem{_}resistan(t|ce)\b", "carbapenem resistance"),
    (r"\bcarbapenemases?\b", "carbapenemase"),
    (r"(?-i:\b(CPE|CPO|CRE|CRAB|CRPA)s?\b)", "carbapenem-resistant organism acronym"),
    (r"(?-i:\bESBLs?\b)", "ESBL"),
    (rf"\bextended{_}spectrum{_}(beta|\u03b2)(?:{_})?lactamases?\b", "extended-spectrum beta-lactamase"),
    (rf"(?-i:\bEARS{_}Net\b)", "EARS-Net"),
    (r"(?-i:\bCAESAR\b)", "CAESAR"),
    (r"(?-i:\bMRSA\b)", "MRSA"),
    (rf"\bmeth?icillin{_}resistant\b", "methicillin-resistant"),
    (r"(?-i:\bVRE\b)", "VRE"),
    (rf"\bvancomycin{_}resistan(t|ce)\b", "vancomycin resistance"),
    (rf"\bcolistin{_}resistan(t|ce)\b", "colistin resistance"),
    (rf"\bantimicrobial{_}stewardship\b", "antimicrobial stewardship"),
    (rf"\b(antimicrobial|antibiotic){_}(consumption|use)\b", "antimicrobial consumption"),
    (rf"\bpan(?:{_})?drug{_}resistant\b", "pan-drug-resistant"),
    (rf"\bextensively{_}drug{_}resistant\b", "extensively drug-resistant"),
    (r"(?-i:\bXDR\b)", "XDR"),
    (r"(?-i:\bEUCAST\b)", "EUCAST"),
]

# Tier 2 -> 'review': healthcare-associated infections, priority pathogens and resistance wording that may not be
# antibacterial (e.g. "drug-resistant" also covers antivirals). A human decides.
TIER_2_PATTERNS = [
    (rf"\b(healthcare|health{_}care){_}associated{_}infections?\b", "healthcare-associated infections"),
    (rf"\bhospital{_}acquired{_}infections?\b", "hospital-acquired infections"),
    (r"\bnosocomial\b", "nosocomial"),
    (rf"\bdrug{_}resistan(t|ce)\b", "drug-resistant"),
    (rf"\bAcinetobacter{_}baumannii\b", "Acinetobacter baumannii"),
    (rf"\bKlebsiella{_}pneumoniae\b", "Klebsiella pneumoniae"),
    (rf"\bPseudomonas{_}aeruginosa\b", "Pseudomonas aeruginosa"),
    (rf"\bEnterococcus{_}faeci(um|alis)\b", "Enterococcus"),
    (rf"\bEnterobacter{_}cloacae\b", "Enterobacter cloacae"),
    (rf"\bClostridioides{_}difficile\b", "Clostridioides difficile"),
    (r"\bC\.\s*difficile\b", "C. difficile"),
    (rf"\bhospital{_}outbreaks?\b", "hospital outbreak"),
    (rf"\binfection{_}prevention{_}and{_}control\b", "infection prevention and control"),
    (r"(?-i:\bIPC\b)", "IPC"),
]


@dataclass
class ClassificationResult:
    category: RelevanceCategory
    matched_terms: list[str]
    score: int


class RelevanceFilter:
    """Configurable relevance classifier with pre-compiled regex rules."""

    def __init__(
        self,
        tier_1: list[tuple[str, str]] | None = None,
        tier_2: list[tuple[str, str]] | None = None,
    ) -> None:
        raw_t1 = tier_1 or TIER_1_PATTERNS
        raw_t2 = tier_2 or TIER_2_PATTERNS

        self.rules_t1 = [
            Rule(pattern=re.compile(pat, re.IGNORECASE), label=lbl, weight=20)
            for pat, lbl in raw_t1
        ]
        self.rules_t2 = [
            Rule(pattern=re.compile(pat, re.IGNORECASE), label=lbl, weight=5)
            for pat, lbl in raw_t2
        ]

    def classify(self, title: str, summary: str, categories: list[str] | None = None) -> ClassificationResult:
        """Classify announcement text into relevant, review, or unrelated."""
        # Combine text for matching. Title matches get higher significance.
        all_text = f"{title} {summary} {' '.join(categories or [])}"

        matched_t1: list[str] = []
        for rule in self.rules_t1:
            if rule.pattern.search(all_text):
                matched_t1.append(rule.label)

        if matched_t1:
            # Found definite AMR terms
            return ClassificationResult(
                category=RelevanceCategory.RELEVANT,
                matched_terms=sorted(set(matched_t1)),
                score=len(matched_t1) * 20,
            )

        matched_t2: list[str] = []
        for rule in self.rules_t2:
            if rule.pattern.search(all_text):
                matched_t2.append(rule.label)

        if matched_t2:
            # Found HAI or pathogen terms without explicit resistance
            return ClassificationResult(
                category=RelevanceCategory.REVIEW,
                matched_terms=sorted(set(matched_t2)),
                score=len(matched_t2) * 5,
            )

        return ClassificationResult(
            category=RelevanceCategory.UNRELATED,
            matched_terms=[],
            score=0,
        )


# Global default instance
_DEFAULT_FILTER = RelevanceFilter()


def classify_announcement(
    title: str,
    summary: str,
    categories: list[str] | None = None,
) -> tuple[str, list[str]]:
    """Convenience helper returning (category_str, list_of_matched_terms)."""
    result = _DEFAULT_FILTER.classify(title, summary, categories)
    return result.category.value, result.matched_terms

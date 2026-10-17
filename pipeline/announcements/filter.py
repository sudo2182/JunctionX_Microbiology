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


# Tier 1: Explicit AMR surveillance, phenotype, and resistance terms.
# Uses word boundaries (\b) and accounts for hyphenation, spaces, and plurals.
TIER_1_PATTERNS = [
    (r"\bantimicrobial\s+resistance\b", "antimicrobial resistance"),
    (r"\bantibiotic\s+resistance\b", "antibiotic resistance"),
    (r"\b\bAMR\b", "AMR"),
    (r"\bantimicrobial\s+susceptibility\b", "antimicrobial susceptibility"),
    (r"\bresistant\s+bacteria\b", "resistant bacteria"),
    (r"\b(multi|multidrug|multi-drug)[\s-]resistant\b", "multidrug-resistant"),
    (r"\bMDRO\b", "MDRO"),
    (r"\bcarbapenem[\s-]resist(ant|ance)\b", "carbapenem resistance"),
    (r"\bcarbapenemase[\s-]producing\b", "carbapenemase-producing"),
    (r"\bcarbapenemase(s)?\b", "carbapenemase"),
    (r"\bCPE\b", "CPE"),
    (r"\bCRE\b", "CRE"),
    (r"\bESBL(s)?\b", "ESBL"),
    (r"\bextended[\s-]spectrum\s+(beta|β)[\s-]lactamase(s)?\b", "extended-spectrum beta-lactamase"),
    (r"\bEARS[\s-]Net\b", "EARS-Net"),
    (r"\bCAESAR\b", "CAESAR"),
    (r"\bMRSA\b", "MRSA"),
    (r"\bmethicillin[\s-]resistant\s+Staphylococcus\s+aureus\b", "methicillin-resistant Staphylococcus aureus"),
    (r"\bVRE\b", "VRE"),
    (r"\bvancomycin[\s-]resistant\b", "vancomycin-resistant"),
    (r"\bcolistin[\s-]resist(ant|ance)\b", "colistin resistance"),
    (r"\bantimicrobial\s+stewardship\b", "antimicrobial stewardship"),
    (r"\bantimicrobial\s+consumption\b", "antimicrobial consumption"),
    (r"\bantibiotic\s+consumption\b", "antibiotic consumption"),
    (r"\bantimicrobial\s+use\b", "antimicrobial use"),
    (r"\bpan[\s-]drug[\s-]resistant\b", "pan-drug-resistant"),
    (r"\bextensively[\s-]drug[\s-]resistant\b", "extensively drug-resistant"),
    (r"\bXDR\b", "XDR"),
    (r"\bEUCAST\b", "EUCAST"),
]

# Tier 2: Healthcare-associated infections (HAI) or priority pathogen reports
# that warrant clinical/epidemiological review if resistance is not explicitly stated in the title.
TIER_2_PATTERNS = [
    (r"\bhealthcare[\s-]associated\s+infection(s)?\b", "healthcare-associated infections"),
    (r"\bhospital[\s-]acquired\s+infection(s)?\b", "hospital-acquired infections"),
    (r"\bnosocomial\b", "nosocomial"),
    (r"\bAcinetobacter\s+baumannii\b", "Acinetobacter baumannii"),
    (r"\bKlebsiella\s+pneumoniae\b", "Klebsiella pneumoniae"),
    (r"\bPseudomonas\s+aeruginosa\b", "Pseudomonas aeruginosa"),
    (r"\bEnterococcus\s+faecium\b", "Enterococcus faecium"),
    (r"\bEnterococcus\s+faecalis\b", "Enterococcus faecalis"),
    (r"\bClostridioides\s+difficile\b", "Clostridioides difficile"),
    (r"\bC\.\s*difficile\b", "C. difficile"),
    (r"\bhospital\s+outbreak(s)?\b", "hospital outbreak"),
    (r"\binfection\s+prevention\s+and\s+control\b", "infection prevention and control"),
    (r"\bIPC\s+guidance\b", "IPC guidance"),
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

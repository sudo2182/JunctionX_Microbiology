"""Weekly anomaly detection (BUILD_PLAN §7).

``Engine(isolates, markers).detect_week(t)`` runs every signal family for the week
ending at ``week_idx == t`` using only data released up to ``t``, and returns ranked
``Alert`` objects with their explanation payload. ``detect_range`` replays many weeks.

Signal families:
  rate      %R or phenotype share, current window vs the 52 weeks before it,
            exact binomial upper tail, Benjamini-Hochberg across the week's tests
  count     distinct patients with MRSA / ESBL / 3GC-R / CPE / VRE in 4 weeks vs the
            52-week expectation, Poisson upper tail
  sentinel  any new CPE, VRE, carbapenem-R Enterobacterales or blood MRSA patient
  drift     latest 52 weeks vs the previous 52, two-proportion z-test (informational)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from . import stats
from .config import (
    COUNT_RULES,
    PHENOTYPE_RATES,
    PHENOTYPES,
    REDUNDANT_AGENTS,
    CountRule,
    Rules,
)
from .data import week_label, week_range_label
from .explain import explain, sentence
from .scoring import score

SCOPE_COLUMN = {"hospital": None, "ward": "ward_code", "setting": "setting", "onset": None}
ORGANISM_CODES = {
    "Escherichia coli": "ECOLI",
    "Klebsiella pneumoniae": "KPNE",
    "Klebsiella oxytoca": "KOXY",
    "Proteus mirabilis": "PMIR",
    "Citrobacter freundii": "CFRE",
    "Pseudomonas aeruginosa": "PAER",
    "Staphylococcus aureus": "SAUR",
    "Staphylococcus saprophyticus": "SSAP",
    "Enterococcus faecalis": "EFAE",
    "3GC-R Enterobacterales": "ENTB",
    "ESBL": "ENTB",
    "CPE": "ENTB",
    "Carbapenem-R Enterobacterales": "ENTB",
    "MRSA": "SAUR",
    "Blood MRSA": "SAUR",
    "VRE": "EFAE",
}
RATE_KEY = ["organism", "specimen", "marker", "scope_value"]


@dataclass
class Window:
    first: int
    last: int

    @property
    def weeks(self) -> int:
        return self.last - self.first + 1

    def label(self) -> str:
        return week_range_label(self.first, self.last)


def current_and_baseline(t: int, weeks: int, baseline_weeks: int) -> tuple[Window, Window]:
    """Current = weeks t-weeks+1..t; baseline = the baseline_weeks immediately before it."""
    cur = Window(t - weeks + 1, t)
    return cur, Window(cur.first - baseline_weeks, cur.first - 1)


@dataclass
class Alert:
    week_idx: int
    type: str
    organism: str
    marker: str
    specimen: str
    scope_type: str
    scope_value: str
    evidence: dict[str, Any]
    severity_points: int = 0
    severity: str = "low"
    confidence: str = "low"
    rank: float = 0.0
    sentence: str = ""

    @property
    def key(self) -> str:
        """Episode key: the same signal in consecutive weeks updates one episode."""
        return f"{self.type}|{self.organism}|{self.marker}|{self.specimen}|{self.scope_type}|{self.scope_value}"

    @property
    def alert_id(self) -> str:
        """Public id used by the RSS feed and dashboard deep links, e.g. A-2025W24-URO-ECOLI-URINE-ESBL."""
        org = ORGANISM_CODES.get(self.organism, self.organism.upper().replace(" ", "").replace(".", ""))
        parts = [
            week_label(self.week_idx).replace("-", ""),
            self.scope_value.upper(),
            org,
            self.specimen.upper(),
            self.marker.upper(),
        ]
        return "A-" + "-".join(parts)

    def to_dict(self) -> dict[str, Any]:
        """The section 7.4 evidence JSON: one agg.alert_firings.evidence row.

        Read by pipeline.feeds and by the dashboard's AlertEvidence type, so a few values appear
        under both consumers' names (severity_points / rank_score, expected.count / baseline.expected_4w).
        """
        ev = {k: v for k, v in self.evidence.items()}
        current = dict(ev.pop("current"))
        current["window_weeks"] = current.get("n_weeks", 1 if self.type == "sentinel" else 4)
        baseline = ev.pop("baseline")
        if baseline is not None:
            baseline = dict(baseline)
            if "count" in baseline:
                baseline["count_52w"] = baseline["count"]
                baseline["expected_4w"] = ev["expected"]["count"]
        onset = ev.get("breakdown", {}).get("onset", {})
        return {
            "alert_id": self.alert_id,
            "key": self.key,
            "week_idx": self.week_idx,
            "week": week_label(self.week_idx),
            "type": self.type,
            "organism": self.organism,
            "marker": self.marker,
            "specimen": self.specimen,
            "scope": {"type": self.scope_type, "value": self.scope_value},
            "severity": self.severity,
            "severity_points": self.severity_points,
            "confidence": self.confidence,
            "rank": self.rank,
            "rank_score": self.rank,
            "sentence": self.sentence,
            "current": current,
            "baseline": baseline,
            "distinct_patients": ev.pop("distinct_patients", None),
            "breakdown": ev.pop("breakdown", {}),
            "co_resistance": ev.pop("co_resistance", {}),
            "hospital_onset_share": round(onset.get("hospital", 0) / sum(onset.values()), 2) if onset else None,
            **ev,
        }


class Engine:
    def __init__(self, isolates: pd.DataFrame, markers: pd.DataFrame, rules: Rules | None = None):
        self.rules = rules or Rules()
        iso = isolates.sort_values(["sample_date", "isolate_id"]).reset_index(drop=True)
        self.isolates = iso
        self._iso_weeks = iso["week_idx"].to_numpy()
        long = markers.merge(iso, on="isolate_id", how="inner")
        long = long.sort_values(["week_idx", "isolate_id"]).reset_index(drop=True)
        self.long = long
        self._long_weeks = long["week_idx"].to_numpy()
        self.last_week = int(iso["week_idx"].max())
        self._rate_mask = self._rate_eligible(long)

    # ------------------------------------------------------------------ slicing
    @staticmethod
    def _rate_eligible(long: pd.DataFrame) -> np.ndarray:
        pheno = long["marker"].isin(PHENOTYPES)
        allowed_pheno = np.zeros(len(long), dtype=bool)
        for marker, orgs in PHENOTYPE_RATES.items():
            allowed_pheno |= (long["marker"] == marker) & long["organism"].isin(orgs)
        redundant = pd.Series(list(zip(long["organism"], long["marker"], strict=True)), index=long.index).isin(
            REDUNDANT_AGENTS
        )
        return ((~pheno & ~redundant) | allowed_pheno).to_numpy()

    def _iso_window(self, w: Window) -> pd.DataFrame:
        lo, hi = np.searchsorted(self._iso_weeks, [w.first, w.last + 1])
        sub = self.isolates.iloc[lo:hi]
        # isolates are sorted by date globally, but searchsorted needs week order too
        return sub[(sub["week_idx"] >= w.first) & (sub["week_idx"] <= w.last)]

    def _long_window(self, w: Window) -> pd.DataFrame:
        lo, hi = np.searchsorted(self._long_weeks, [w.first, w.last + 1])
        return self.long.iloc[lo:hi]

    def first_isolates(self, w: Window, scope: str, all_specimens: bool = False) -> pd.DataFrame:
        """CLSI M39 first isolate per patient x species x specimen within the window and scope."""
        iso = self._iso_window(w)
        if scope == "onset":
            iso = iso[iso["onset"] == "hospital"]
        keys = ["patient_id", "organism"] + ([] if all_specimens else ["specimen"])
        col = SCOPE_COLUMN[scope]
        if col:
            keys.append(col)
        return iso.drop_duplicates(keys)

    def window_rates(self, w: Window, scope: str) -> pd.DataFrame:
        """n first isolates tested and x resistant per organism x specimen x marker x scope value."""
        long = self._long_window(w)
        lo = np.searchsorted(self._long_weeks, w.first)
        mask = self._rate_mask[lo : lo + len(long)]
        long = long[mask]
        col = SCOPE_COLUMN[scope]
        frames = []
        for all_spec in (False, True):
            ids = self.first_isolates(w, scope, all_specimens=all_spec)["isolate_id"]
            sub = long[long["isolate_id"].isin(ids)]
            if all_spec:  # phenotype shares across specimens, e.g. ward ESBL share
                sub = sub[sub["marker"].isin(PHENOTYPES)].assign(specimen="all")
            sub = sub.assign(scope_value=sub[col] if col else ("hospital" if scope == "onset" else "ALL"))
            frames.append(sub.groupby(RATE_KEY)["resistant"].agg(n="size", x="sum"))
        return pd.concat(frames)

    # ------------------------------------------------------------------ rate signals
    def _rate_candidates(self, t: int) -> list[dict[str, Any]]:
        r = self.rules
        tests: list[dict[str, Any]] = []
        for scope in r.scopes:
            pending: pd.Index | None = None
            for weeks in (r.current_weeks, *r.widen_to):
                cur_w, base_w = current_and_baseline(t, weeks, r.baseline_weeks)
                if base_w.first < 1:
                    break
                cur = self.window_rates(cur_w, scope)
                if pending is not None:
                    cur = cur[cur.index.isin(pending)]
                big = cur[cur["n"] >= r.min_n]
                small = cur[cur["n"] < r.min_n]
                if len(big):
                    base = self.window_rates(base_w, scope)
                    tests += self._rate_tests(big, base, cur_w, base_w, scope)
                pending = small.index
                if not len(pending):
                    break
            if scope == "hospital":
                cur_w, base_w = current_and_baseline(t, 1, r.baseline_weeks)
                if base_w.first >= 1:
                    cur = self.window_rates(cur_w, scope)
                    combos = pd.MultiIndex.from_tuples(r.weekly_combos)
                    keep = pd.MultiIndex.from_arrays(
                        [cur.index.get_level_values(0), cur.index.get_level_values(1)]
                    ).isin(combos)
                    cur = cur[keep & (cur["n"] >= r.min_n).to_numpy()]
                    if len(cur):
                        tests += self._rate_tests(cur, self.window_rates(base_w, scope), cur_w, base_w, scope)
        return tests

    def _rate_tests(self, cur, base, cur_w: Window, base_w: Window, scope: str) -> list[dict[str, Any]]:
        r = self.rules
        joined = cur.join(base, rsuffix="_b", how="inner")
        joined = joined[joined["n_b"] >= r.min_n]
        out = []
        for (organism, specimen, marker, scope_value), row in joined.iterrows():
            n, x, nb, xb = int(row.n), int(row.x), int(row.n_b), int(row.x_b)
            p0 = max(xb / nb, r.zero_floor_numerator / nb)
            out.append(
                {
                    "organism": organism,
                    "specimen": specimen,
                    "marker": marker,
                    "scope_type": scope,
                    "scope_value": scope_value,
                    "cur_w": cur_w,
                    "base_w": base_w,
                    "n": n,
                    "x": x,
                    "nb": nb,
                    "xb": xb,
                    "p0": p0,
                    "p": stats.binom_sf(x, n, p0),
                }
            )
        return out

    def rate_alerts(self, t: int) -> list[Alert]:
        r = self.rules
        tests = self._rate_candidates(t)
        qs = stats.benjamini_hochberg([c["p"] for c in tests])
        alerts = []
        for c, q in zip(tests, qs, strict=True):
            pct, pct_b = c["x"] / c["n"], c["xb"] / c["nb"]
            abs_pp = 100 * (pct - pct_b)
            ratio = pct / c["p0"]
            if q >= r.q_threshold or not (abs_pp >= r.min_abs_pp or (ratio >= r.min_ratio and abs_pp > 0)):
                continue
            evidence = {
                "current": _window_evidence(c["cur_w"], c["n"], c["x"]),
                "baseline": _window_evidence(c["base_w"], c["nb"], c["xb"]),
                "effect": {"abs_pp": round(abs_pp, 1), "ratio": round(ratio, 2)},
                "test": {"name": "exact binomial, one-sided", "p": c["p"], "q": q, "tests_this_week": len(tests)},
                "rule": f"rate: q<{r.q_threshold} and (abs>={r.min_abs_pp}pp or ratio>={r.min_ratio}), "
                f"n_current>={r.min_n}, n_baseline>={r.min_n}",
                "_window": c["cur_w"],
            }
            alerts.append(
                Alert(t, "rate", c["organism"], c["marker"], c["specimen"], c["scope_type"], c["scope_value"], evidence)
            )
        return alerts

    # ------------------------------------------------------------------ count + sentinel signals
    def _positives(self, w: Window, rule: CountRule, specimen: str | None = None) -> pd.DataFrame:
        long = self._long_window(w)
        sub = long[(long["marker"] == rule.marker) & long["resistant"] & long["organism"].isin(rule.organisms)]
        if specimen:
            sub = sub[sub["specimen"] == specimen]
        return sub

    def count_alerts(self, t: int) -> list[Alert]:
        r = self.rules
        cur_w, base_w = current_and_baseline(t, r.current_weeks, r.baseline_weeks)
        if base_w.first < 1:
            return []
        alerts = []
        for rule in COUNT_RULES:
            if rule.sentinel:
                continue
            cur, base = self._positives(cur_w, rule), self._positives(base_w, rule)
            for scope, col in (("hospital", None), ("ward", "ward_code")):
                groups = (
                    [("ALL", cur, base)] if col is None else [(v, g, base[base[col] == v]) for v, g in cur.groupby(col)]
                )
                for value, g, gb in groups:
                    k = g["patient_id"].nunique()
                    if k < r.count_min_k:
                        continue
                    b = gb["patient_id"].nunique()
                    lam = max(b / r.baseline_weeks * r.current_weeks, r.count_lambda_floor)
                    p = stats.poisson_sf(k, lam)
                    if p >= r.count_p_threshold:
                        continue
                    evidence = {
                        "current": {"weeks": cur_w.label(), "k": int(k)},
                        "baseline": {"weeks": base_w.label(), "count": int(b)},
                        "expected": {"count": round(lam, 2)},
                        "effect": {"ratio": round(k / lam, 2)},
                        "test": {"name": "Poisson, one-sided", "p": p},
                        "rule": f"count: p<{r.count_p_threshold} and k>={r.count_min_k}",
                        "_isolates": g,
                    }
                    alerts.append(Alert(t, "count", rule.name, rule.marker, "all", scope, value, evidence))
        return alerts

    def sentinel_alerts(self, t: int) -> list[Alert]:
        r = self.rules
        week = Window(t, t)
        history = Window(max(1, t - r.baseline_weeks), t - 1)
        alerts = []
        covered: set[tuple[str, str]] = set()  # (isolate, organism) already reported this week
        for rule in COUNT_RULES:
            if not rule.sentinel:
                continue
            cur = self._positives(week, rule, rule.sentinel_specimen)
            # a CPE isolate is also meropenem-R: report it once, under the earlier (more specific) rule
            seen = pd.Series(list(zip(cur["isolate_id"], cur["organism"], strict=True)), index=cur.index, dtype=object)
            cur = cur[~seen.isin(covered)] if len(cur) else cur
            covered.update(zip(cur["isolate_id"], cur["organism"], strict=True))
            if cur.empty:
                continue
            if history.last >= history.first:  # known carriers do not re-fire
                known = self._positives(history, rule, rule.sentinel_specimen)["patient_id"]
                cur = cur[~cur["patient_id"].isin(known)]
            for ward, g in cur.groupby("ward_code"):
                evidence = {
                    "current": {"weeks": week.label(), "k": int(g["patient_id"].nunique())},
                    "baseline": None,
                    "effect": None,
                    "test": {"name": "sentinel event", "p": None},
                    "rule": "sentinel: any new patient",
                    "_isolates": g,
                }
                specimen = rule.sentinel_specimen or "all"
                alerts.append(Alert(t, "sentinel", rule.name, rule.marker, specimen, "ward", ward, evidence))
        return alerts

    # ------------------------------------------------------------------ drift
    def drift_alerts(self, t: int) -> list[Alert]:
        """Slow change: Cochran-Armitage trend across 13-week blocks of released history."""
        r = self.rules
        if t % r.drift_every_weeks:
            return []
        n_blocks = min(r.drift_max_blocks, t // r.drift_block_weeks)
        if n_blocks < r.drift_min_blocks:
            return []
        blocks = [
            Window(t - (n_blocks - i) * r.drift_block_weeks + 1, t - (n_blocks - i - 1) * r.drift_block_weeks)
            for i in range(n_blocks)
        ]
        table = pd.concat(
            [self.window_rates(b, "hospital").assign(block=i) for i, b in enumerate(blocks)]
        ).reset_index()
        table = table[table["specimen"] != "all"]
        tests = []
        for key, g in table.groupby(RATE_KEY):
            g = g.set_index("block")[["n", "x"]].reindex(range(n_blocks), fill_value=0)
            if (g["n"] < r.min_n).any():
                continue
            z, p = stats.cochran_armitage(g["x"].tolist(), g["n"].tolist())
            tests.append((key, g, z, p))
        qs = stats.benjamini_hochberg([p for *_, p in tests])
        alerts = []
        years = n_blocks * r.drift_block_weeks / 52
        for (key, g, z, p), q in zip(tests, qs, strict=True):
            organism, specimen, marker, scope_value = key
            half = n_blocks // 2
            early, late = g.iloc[:half], g.iloc[-half:]
            first_pct = 100 * early["x"].sum() / early["n"].sum()
            last_pct = 100 * late["x"].sum() / late["n"].sum()
            per_year = (last_pct - first_pct) / (years / 2)
            if q >= r.drift_q_threshold or per_year < r.drift_min_pp_per_year:
                continue
            first_w = Window(blocks[0].first, blocks[half - 1].last)
            last_w = Window(blocks[-half].first, blocks[-1].last)
            evidence = {
                "current": _window_evidence(last_w, int(late["n"].sum()), int(late["x"].sum())),
                "baseline": _window_evidence(first_w, int(early["n"].sum()), int(early["x"].sum())),
                "effect": {"abs_pp": round(last_pct - first_pct, 1), "pp_per_year": round(per_year, 1)},
                "test": {"name": "Cochran-Armitage trend, one-sided", "z": round(z, 2), "p": p, "q": q},
                "series": [
                    {"weeks": b.label(), "n": int(row.n), "x": int(row.x), "pct": round(100 * row.x / row.n, 1)}
                    for b, row in zip(blocks, g.itertuples(), strict=True)
                ],
                "rule": f"drift: q<{r.drift_q_threshold} and >= {r.drift_min_pp_per_year} pp/year, "
                f"{r.drift_block_weeks}-week blocks",
            }
            alerts.append(Alert(t, "drift", organism, marker, specimen, "hospital", scope_value, evidence))
        return alerts

    # ------------------------------------------------------------------ orchestration
    def detect_week(self, t: int) -> list[Alert]:
        """All alerts for the week ending at t, explained, scored and ranked."""
        alerts = self.rate_alerts(t) + self.count_alerts(t) + self.sentinel_alerts(t) + self.drift_alerts(t)
        for a in alerts:
            explain(self, a)
            score(a)
            a.sentence = sentence(a)
        alerts.sort(key=lambda a: (-a.rank, -a.severity_points))
        return alerts

    def detect_range(self, first: int, last: int | None = None) -> list[Alert]:
        last = self.last_week if last is None else last
        out: list[Alert] = []
        for t in range(first, last + 1):
            out += self.detect_week(t)
        return out


def _window_evidence(w: Window, n: int, x: int) -> dict[str, Any]:
    lo, hi = stats.wilson(x, n)
    return {
        "weeks": w.label(),
        "n_weeks": w.weeks,
        "n": n,
        "x": x,
        "pct": round(100 * x / n, 1),
        "ci": [round(100 * lo, 1), round(100 * hi, 1)],
    }

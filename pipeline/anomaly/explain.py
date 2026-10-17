"""Alert explanation: structured evidence plus a templated sentence (BUILD_PLAN §7.4).

Nothing here is free text from a model: the sentence is filled from the evidence dict,
so every number a user reads can be traced back to the payload stored with the alert.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import pandas as pd

from .config import CO_RESISTANCE_AGENTS, PHENOTYPES

if TYPE_CHECKING:
    from .engine import Alert, Engine

SCOPE_NAMES = {
    "ALL": "Hospital-wide",
    "inpatient": "Inpatients",
    "ed": "Emergency department",
    "primary_care": "Primary care",
    "hospital": "Hospital-onset",
}
WARD_NAMES = {
    "ED": "Emergency department",
    "MED-A": "Internal medicine A",
    "MED-B": "Internal medicine B",
    "SURG": "Surgery",
    "URO": "Urology",
    "ICU": "Intensive care",
    "GER": "Geriatrics",
    "PHC-N": "Health centre North",
    "PHC-S": "Health centre South",
}
AGENT_NAMES = {
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


def resistant_isolates(engine: Engine, alert: Alert) -> pd.DataFrame:
    """The resistant first isolates behind a rate or drift alert (long rows for its marker)."""
    w = alert.evidence["_window"]
    first = engine.first_isolates(w, alert.scope_type, all_specimens=alert.specimen == "all")
    first = first[first["organism"] == alert.organism]
    if alert.specimen != "all":
        first = first[first["specimen"] == alert.specimen]
    if alert.scope_type in ("ward", "setting"):
        col = "ward_code" if alert.scope_type == "ward" else "setting"
        first = first[first[col] == alert.scope_value]
    long = engine._long_window(w)
    hits = long[long["isolate_id"].isin(first["isolate_id"]) & (long["marker"] == alert.marker) & long["resistant"]]
    return hits


def explain(engine: Engine, alert: Alert) -> None:
    ev = alert.evidence
    if "_isolates" in ev:
        hits = ev.pop("_isolates")
    elif "_window" in ev:
        hits = resistant_isolates(engine, alert)
    else:
        hits = None
    ev.pop("_window", None)
    if alert.type == "drift" or hits is None:
        return
    ev["distinct_patients"] = int(hits["patient_id"].nunique())
    ev["breakdown"] = {
        "onset": {k: int(v) for k, v in hits.drop_duplicates("patient_id")["onset"].value_counts().items()},
        "specimen": {k: int(v) for k, v in hits["specimen"].value_counts().items()},
    }
    if alert.scope_type != "ward":
        ev["breakdown"]["ward"] = {k: int(v) for k, v in hits["ward_code"].value_counts().head(5).items()}
    ev["isolate_count"] = int(hits["isolate_id"].nunique())
    # co-resistance among the flagged isolates
    tested = engine.long[engine.long["isolate_id"].isin(hits["isolate_id"])]
    tested = tested[tested["marker"].isin(CO_RESISTANCE_AGENTS) & (tested["marker"] != alert.marker)]
    co = tested.groupby("marker")["resistant"].mean()
    ev["co_resistance"] = {k: round(float(v), 2) for k, v in co.items()}


def _place(alert: Alert) -> str:
    if alert.scope_type == "ward":
        return WARD_NAMES.get(alert.scope_value, alert.scope_value)
    return SCOPE_NAMES.get(alert.scope_value, alert.scope_value)


def _what(alert: Alert) -> str:
    if alert.marker in PHENOTYPES:
        return f"{alert.marker} share"
    return f"{AGENT_NAMES.get(alert.marker, alert.marker)} resistance"


def _patients(ev: dict) -> str:
    n = ev.get("distinct_patients")
    if n is None:
        return ""
    onset = ev.get("breakdown", {}).get("onset", {})
    tail = f", {onset['hospital']} hospital-onset" if onset.get("hospital") else ""
    return f" {n} different patient{'s' if n != 1 else ''}{tail}."


def sentence(alert: Alert) -> str:
    ev = alert.evidence
    place = _place(alert)
    if alert.type in ("rate", "drift"):
        c, b = ev["current"], ev["baseline"]
        spec = "" if alert.specimen == "all" else f", {alert.specimen}"
        if alert.type == "drift":
            return (
                f"{place}{spec}, {alert.organism}: {_what(alert)} is trending up by about "
                f"{ev['effect']['pp_per_year']} percentage points a year, from {b['pct']}% ({b['weeks']}) "
                f"to {c['pct']}% ({c['weeks']})."
            )
        span = f"in the last {c['n_weeks']} weeks"
        prev = "the previous 52 weeks"
        return (
            f"{place}{spec}, {alert.organism}: {_what(alert)} rose to {c['pct']}% "
            f"({c['x']} of {c['n']}, 95% CI {c['ci'][0]}-{c['ci'][1]}%) {span}, "
            f"against {b['pct']}% ({b['x']} of {b['n']}) in {prev}." + _patients(ev)
        )
    if alert.type == "count":
        c = ev["current"]
        onset = ev.get("breakdown", {}).get("onset", {})
        tail = f" {onset['hospital']} hospital-onset." if onset.get("hospital") else ""
        return (
            f"{place}: {c['k']} patients with {alert.organism} in the last 4 weeks "
            f"({c['weeks']}), against about {ev['expected']['count']} expected from the previous 52 weeks." + tail
        )
    k = ev["current"]["k"]
    return f"{place}: {alert.organism} in {k} new patient{'s' if k != 1 else ''} this week ({ev['current']['weeks']})."

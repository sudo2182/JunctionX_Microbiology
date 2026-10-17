"""Build the dashboard's local mock data from the synthetic LIS export.

The real dashboard reads Supabase `api.*` views written by the pipeline. Until those exist,
this script computes the same aggregates from TYKS_data/*.csv so the UI runs on realistic
numbers, including the two planted outbreaks:

  - cleaning rules R1 (intrinsic R flagged and excluded), R2 (urine-only agents), R3 (onset), R5 (setting)
  - first isolate per patient x organism x specimen, de-duplicated within each window
  - window counts for 1 / 4 / 13 / 52 weeks at every end week, per scope
  - a SIMPLIFIED copy of the anomaly engine in BUILD_PLAN section 7 (rate, count, sentinel, drift)
    so the alerts views have something to show. The real engine lives in pipeline/detect.py.

Output: dashboard/src/mock/*.json (compact, cursor independent). The TypeScript mock source in
src/lib/data/mock.ts turns these into rows shaped exactly like the api views.

Run from the repo root:  python3 dashboard/scripts/build_mock.py
"""

from __future__ import annotations

import gzip
import json
import math
from collections import defaultdict
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "TYKS_data"
OUT = ROOT / "dashboard" / "src" / "mock"

WINDOWS = [1, 4, 13, 52]
INTRINSIC = {
    ("Klebsiella pneumoniae", "AMP"),
    ("Klebsiella oxytoca", "AMP"),
    ("Citrobacter freundii", "AMP"),
    ("Proteus mirabilis", "NIT"),
}
ENTEROBACTERALES = {
    "Escherichia coli", "Klebsiella pneumoniae", "Klebsiella oxytoca",
    "Citrobacter freundii", "Proteus mirabilis",
}
PHENOTYPES = {
    "ESBL": {"Escherichia coli", "Klebsiella pneumoniae"},
    "MRSA": {"Staphylococcus aureus"},
    "VRE": {"Enterococcus faecalis"},
    "CPE": ENTEROBACTERALES,
}
PRIORITY_MARKERS = {"ESBL", "MRSA", "VRE", "CPE", "MEM"}
FIRST_LINE = {("urine", "TMP"), ("urine", "MEC"), ("urine", "NIT"), ("blood", "CRO")}
CO_RES_CODES = ["CIP", "TMP", "CRO", "TZP", "MEM", "NIT", "CLI"]


# ----------------------------------------------------------------------------- load + clean
def load():
    cul = pd.read_csv(RAW / "cultures.csv", parse_dates=["sample_date", "admission_date"])
    iso = pd.read_csv(RAW / "isolates.csv")
    sus = pd.read_csv(RAW / "susceptibility.csv")
    pat = pd.read_csv(RAW / "patients.csv")
    abx = pd.read_csv(RAW / "antibiotics.csv")
    wards = pd.read_csv(RAW / "wards.csv")

    weeks = cul[["iso_year", "iso_week"]].drop_duplicates().sort_values(["iso_year", "iso_week"])
    weeks["week_idx"] = np.arange(1, len(weeks) + 1)
    cul = cul.merge(weeks, on=["iso_year", "iso_week"])

    day = (cul.sample_date - cul.admission_date).dt.days
    cul["onset"] = np.where(cul.admission_date.isna(), "outpatient",
                            np.where(day >= 2, "hospital", "community"))
    cul["setting"] = np.where(cul.ward_type == "in", "inpatient",
                              np.where(cul.institution == "primary_care", "primary_care", "ed"))
    return cul, iso, sus, pat, abx, wards, weeks


def build_isolate_table(cul, iso, sus, abx):
    urine_only = set(abx.loc[abx.reported_for == "urine", "antibiotic_code"])
    s = sus.merge(cul[["culture_id", "specimen"]], on="culture_id")
    s["is_intrinsic"] = [(o, a) in INTRINSIC for o, a in zip(s.organism, s.antibiotic_code)]
    s["reportable"] = ~(s.antibiotic_code.isin(urine_only) & (s.specimen != "urine"))
    usable = s[~s.is_intrinsic & s.reportable]
    wide = (usable.assign(r=(usable.result == "R").astype(float))
            .pivot_table(index="isolate_id", columns="antibiotic_code", values="r", aggfunc="first"))
    codes = list(wide.columns)

    x = iso.merge(cul[["culture_id", "patient_id", "sample_date", "week_idx", "ward_code",
                       "specimen", "onset", "setting"]], on="culture_id")
    x = x.join(wide, on="isolate_id")
    for ph, orgs in PHENOTYPES.items():
        x[ph] = np.where(x.organism.isin(orgs), x[ph.lower()].astype(float), np.nan)
    x = x.sort_values(["sample_date", "isolate_id"]).reset_index(drop=True)
    dq = {
        "intrinsic_by_week": s[s.is_intrinsic].merge(cul[["culture_id", "week_idx"]], on="culture_id")
        .groupby("week_idx").size(),
        "nonreportable_by_week": s[~s.reportable].merge(cul[["culture_id", "week_idx"]], on="culture_id")
        .groupby("week_idx").size(),
    }
    return x, codes + list(PHENOTYPES), dq


# ----------------------------------------------------------------------------- windows
SCOPES = [("hospital", None), ("ward", "ward_code"), ("setting", "setting"), ("onset", "onset")]


def window_counts(x, markers, n_weeks):
    """series[key] = (n array, x array) over end weeks 1..n_weeks."""
    n = defaultdict(lambda: np.zeros(n_weeks, dtype=np.int32))
    r = defaultdict(lambda: np.zeros(n_weeks, dtype=np.int32))
    for w in WINDOWS:
        for t in range(1, n_weeks + 1):
            sub = x[(x.week_idx > t - w) & (x.week_idx <= t)]
            first = sub.drop_duplicates(["patient_id", "organism", "specimen"], keep="first")
            for spec_mode in ("specimen", "all"):
                f = first if spec_mode == "specimen" else first.assign(specimen="all")
                for scope_type, col in SCOPES:
                    if w == 1 and scope_type != "hospital":
                        continue
                    if spec_mode == "all" and w == 1:
                        continue
                    g = f.assign(scope_value="ALL" if col is None else f[col])
                    agg_n = g.groupby(["organism", "specimen", "scope_value"])[markers].count()
                    agg_r = g.groupby(["organism", "specimen", "scope_value"])[markers].sum()
                    for (org, spec, sv), row in agg_n.iterrows():
                        for m in markers:
                            nv = int(row[m])
                            if nv == 0:
                                continue
                            key = (org, m, spec, scope_type, sv, w)
                            n[key][t - 1] = nv
                            r[key][t - 1] = int(agg_r.at[(org, spec, sv), m])
        print(f"  window {w} done, {len(n)} series so far")
    return n, r


# ----------------------------------------------------------------------------- stats
def wilson(x, n, z=1.96):
    if n == 0:
        return (None, None)
    p = x / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def binom_sf(k, n, p):
    """P(X >= k) for X ~ Bin(n, p)."""
    if k <= 0:
        return 1.0
    if p >= 1:
        return 1.0
    lp, lq = math.log(p), math.log1p(-p)
    total = 0.0
    for i in range(k, n + 1):
        total += math.exp(math.lgamma(n + 1) - math.lgamma(i + 1) - math.lgamma(n - i + 1) + i * lp + (n - i) * lq)
    return min(1.0, total)


def poisson_sf(k, lam):
    if k <= 0:
        return 1.0
    cdf = sum(math.exp(-lam + i * math.log(lam) - math.lgamma(i + 1)) for i in range(k))
    return max(0.0, 1.0 - cdf)


def bh(pvals):
    m = len(pvals)
    order = sorted(range(m), key=lambda i: pvals[i])
    q = [1.0] * m
    prev = 1.0
    for rank in range(m, 0, -1):
        i = order[rank - 1]
        prev = min(prev, pvals[i] * m / rank)
        q[i] = prev
    return q


# ----------------------------------------------------------------------------- engine (simplified)
def week_label(weeks, idx):
    row = weeks.iloc[idx - 1]
    return f"{row.iso_year}-W{row.iso_week:02d}"


def detect(n, r, x, weeks, n_weeks):
    firings = []
    keys4 = [k for k in n if k[5] == 4 and k[1] not in ("VRE", "CPE")]

    for t in range(56, n_weeks + 1):
        tests = []
        # rate signals: 4w (widen to 13w) vs the 52 weeks before the current window
        for k in keys4:
            org, m, spec, st, sv, _ = k
            if spec == "all":  # specimen 'all' only feeds the count rule
                continue
            w = 4
            nc, xc = n[k][t - 1], r[k][t - 1]
            if nc < 30:
                k13 = (org, m, spec, st, sv, 13)
                if k13 in n and n[k13][t - 1] >= 30:
                    w, nc, xc = 13, n[k13][t - 1], r[k13][t - 1]
                else:
                    continue
            kb = (org, m, spec, st, sv, 52)
            if kb not in n or t - w < 1:
                continue
            nb, xb = n[kb][t - w - 1], r[kb][t - w - 1]
            if nb < 30:
                continue
            p0 = max(xb / nb, 0.5 / nb)
            pc = xc / nc
            abs_pp = (pc - xb / nb) * 100
            ratio = pc / p0
            effect = abs_pp >= 5 or (ratio >= 1.5 and abs_pp > 0)
            p = binom_sf(int(xc), int(nc), p0) if pc > p0 and effect else 1.0
            tests.append(dict(key=k, w=w, nc=int(nc), xc=int(xc), nb=int(nb), xb=int(xb), p=p,
                              abs_pp=abs_pp, ratio=ratio, effect=effect))
        q = bh([tt["p"] for tt in tests]) if tests else []
        for tt, qq in zip(tests, q):
            if qq < 0.05 and tt["effect"]:
                firings.append(make_rate_firing(tt, qq, t, x, weeks))

        # count signals: priority phenotypes, all specimens, hospital + ward
        for m in ("MRSA", "ESBL", "CPE", "VRE"):
            for k in [k for k in n if k[1] == m and k[2] == "all" and k[3] in ("hospital", "ward") and k[5] == 4]:
                org, _, spec, st, sv, _ = k
                kc = r[k][t - 1]
                kb = (org, m, spec, st, sv, 52)
                base = r[kb][t - 5] if kb in n and t > 4 else 0
                lam = max(base / 52 * 4, 0.5)
                p = poisson_sf(int(kc), lam)
                if p < 0.01 and kc >= 3:
                    firings.append(make_count_firing(k, int(kc), lam, int(base), p, t, x, weeks))

        # sentinels in the newest week
        wk = x[x.week_idx == t]
        for _, row in wk[(wk.cpe == 1) | (wk.vre == 1) | ((wk.mrsa == 1) & (wk.specimen == "blood"))
                         | (wk.organism.isin(ENTEROBACTERALES) & (wk.MEM == 1))].iterrows():
            m = "CPE" if row.cpe == 1 else "VRE" if row.vre == 1 else "MRSA" if row.mrsa == 1 else "MEM"
            firings.append(make_sentinel_firing(row, m, t, weeks))

        # drift: every 4 weeks, last 52 vs previous 52, hospital, by specimen
        if t >= 104 and t % 4 == 0:
            for k in [k for k in n if k[3] == "hospital" and k[5] == 52 and k[2] != "all"]:
                n1, x1 = n[k][t - 1], r[k][t - 1]
                n0, x0 = n[k][t - 53], r[k][t - 53]
                if n1 < 200 or n0 < 200:
                    continue
                p1, p0 = x1 / n1, x0 / n0
                pp = (x1 + x0) / (n1 + n0)
                se = math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n0)) if 0 < pp < 1 else 0
                if se == 0:
                    continue
                zval = (p1 - p0) / se
                pval = 0.5 * math.erfc(zval / math.sqrt(2))
                if pval < 0.01 and (p1 - p0) * 100 >= 1.5:
                    firings.append(make_drift_firing(k, n1, x1, n0, x0, pval, t, weeks))
    return firings


def ci_pct(x, n):
    lo, hi = wilson(x, n)
    return [round(lo * 100, 1), round(hi * 100, 1)] if lo is not None else None


def window_isolates(x, org, spec, st, sv, t, w):
    sub = x[(x.week_idx > t - w) & (x.week_idx <= t)].drop_duplicates(
        ["patient_id", "organism", "specimen"], keep="first")
    sub = sub[sub.organism == org]
    if spec != "all":
        sub = sub[sub.specimen == spec]
    col = dict(SCOPES)[st]
    if col is not None:
        sub = sub[sub[col] == sv]
    return sub


def describe_flagged(flag):
    return {
        "distinct_patients": int(flag.patient_id.nunique()),
        "breakdown": {
            "ward": {k: int(v) for k, v in flag.ward_code.value_counts().items()},
            "specimen": {k: int(v) for k, v in flag.specimen.value_counts().items()},
            "onset": {k: int(v) for k, v in flag.onset.value_counts().items()},
        },
        "co_resistance": {c: round(float(flag[c].mean()), 2) for c in CO_RES_CODES
                          if c in flag and flag[c].notna().sum() >= 3},
        "hospital_onset_share": round(float((flag.onset == "hospital").mean()), 2) if len(flag) else 0,
    }


def make_rate_firing(tt, q, t, x, weeks):
    org, m, spec, st, sv, _ = tt["key"]
    w = tt["w"]
    flag = window_isolates(x, org, spec, st, sv, t, w)
    flag = flag[flag[m] == 1]
    d = describe_flagged(flag)
    return {
        "type": "rate", "week_idx": t, "organism": org, "marker": m, "specimen": spec,
        "scope": {"type": st, "value": sv},
        "current": {"weeks": f"{week_label(weeks, t - w + 1)}..{week_label(weeks, t)}", "window_weeks": w,
                    "n": tt["nc"], "x": tt["xc"], "pct": round(tt["xc"] / tt["nc"] * 100, 1),
                    "ci": ci_pct(tt["xc"], tt["nc"])},
        "baseline": {"weeks": f"{week_label(weeks, t - w - 51)}..{week_label(weeks, t - w)}",
                     "n": tt["nb"], "x": tt["xb"], "pct": round(tt["xb"] / tt["nb"] * 100, 1),
                     "ci": ci_pct(tt["xb"], tt["nb"])},
        "effect": {"abs_pp": round(tt["abs_pp"], 1), "ratio": round(tt["ratio"], 1)},
        "test": {"name": "exact binomial, one-sided", "p": float(f"{tt['p']:.2g}"), "q": float(f"{q:.2g}")},
        "rule": f"rate: q<0.05 and (abs>=5pp or ratio>=1.5), n_current>=30 ({w}-week window)",
        **d,
    }


def make_count_firing(k, kc, lam, base, p, t, x, weeks):
    org, m, spec, st, sv, _ = k
    flag = window_isolates(x, org, spec, st, sv, t, 4)
    flag = flag[flag[m] == 1]
    return {
        "type": "count", "week_idx": t, "organism": org, "marker": m, "specimen": spec,
        "scope": {"type": st, "value": sv},
        "current": {"weeks": f"{week_label(weeks, t - 3)}..{week_label(weeks, t)}", "window_weeks": 4, "k": kc},
        "baseline": {"weeks": f"{week_label(weeks, max(1, t - 55))}..{week_label(weeks, t - 4)}",
                     "count_52w": base, "expected_4w": round(lam, 2)},
        "effect": {"ratio": round(kc / lam, 1)},
        "test": {"name": "Poisson, one-sided", "p": float(f"{p:.2g}")},
        "rule": "count: p<0.01 and k>=3",
        **describe_flagged(flag),
    }


def make_sentinel_firing(row, m, t, weeks):
    return {
        "type": "sentinel", "week_idx": t, "organism": row.organism, "marker": m, "specimen": row.specimen,
        "scope": {"type": "ward", "value": row.ward_code},
        "current": {"weeks": week_label(weeks, t), "window_weeks": 1, "k": 1},
        "test": {"name": "sentinel event (no baseline)"},
        "rule": "sentinel: any CPE, VRE, meropenem-R Enterobacterales, or blood MRSA",
        "distinct_patients": 1,
        "breakdown": {"ward": {row.ward_code: 1}, "specimen": {row.specimen: 1}, "onset": {row.onset: 1}},
        "co_resistance": {},
        "hospital_onset_share": 1.0 if row.onset == "hospital" else 0.0,
    }


def make_drift_firing(k, n1, x1, n0, x0, p, t, weeks):
    org, m, spec, st, sv, _ = k
    return {
        "type": "drift", "week_idx": t, "organism": org, "marker": m, "specimen": spec,
        "scope": {"type": st, "value": sv},
        "current": {"weeks": f"{week_label(weeks, t - 51)}..{week_label(weeks, t)}", "window_weeks": 52,
                    "n": int(n1), "x": int(x1), "pct": round(x1 / n1 * 100, 1), "ci": ci_pct(x1, n1)},
        "baseline": {"weeks": f"{week_label(weeks, t - 103)}..{week_label(weeks, t - 52)}",
                     "n": int(n0), "x": int(x0), "pct": round(x0 / n0 * 100, 1), "ci": ci_pct(x0, n0)},
        "effect": {"abs_pp": round((x1 / n1 - x0 / n0) * 100, 1), "ratio": round((x1 / n1) / max(x0 / n0, 1e-9), 2)},
        "test": {"name": "two-proportion z-test, one-sided", "p": float(f"{p:.2g}")},
        "rule": "drift: last 52 weeks vs previous 52, p<0.01",
        "distinct_patients": None, "breakdown": {}, "co_resistance": {}, "hospital_onset_share": None,
    }


def score(f):
    pts = 0
    if f["marker"] in PRIORITY_MARKERS:
        pts += 3
    if f["specimen"] == "blood":
        pts += 3
    if (f["specimen"], f["marker"]) in FIRST_LINE:
        pts += 2
    if f["type"] == "rate" and f["effect"]["abs_pp"] >= 15:
        pts += 2
    if f["type"] == "count" and f["effect"]["ratio"] >= 3:
        pts += 2
    if (f.get("hospital_onset_share") or 0) > 0.5:
        pts += 1
    if (f.get("distinct_patients") or 0) >= 5:
        pts += 1
    if f["type"] == "drift":
        pts = min(pts, 2)
    if f["type"] == "sentinel" and f["marker"] == "CPE":
        pts = max(pts, 5)
    band = "critical" if pts >= 7 else "high" if pts >= 5 else "medium" if pts >= 3 else "low"

    t = f["test"]
    if f["type"] == "rate":
        conf = "high" if t["q"] < 0.001 and f["current"]["n"] >= 50 else "medium" if t["q"] < 0.01 else "low"
    elif f["type"] == "count":
        k = f["current"]["k"]
        conf = "high" if t["p"] < 0.001 and k >= 5 else "medium" if t["p"] < 0.01 and k > 3 else "low"
    elif f["type"] == "drift":
        conf = "medium"
    else:
        conf = "low"
    weight = {"high": 1.0, "medium": 0.7, "low": 0.4}[conf]
    f.update(severity_points=pts, severity=band, confidence=conf, rank_score=round(pts * weight, 2))
    return f


# ----------------------------------------------------------------------------- data quality
def data_quality(cul, iso, sus, x, weeks, dq, n_weeks):
    rows = []
    c_by = cul.groupby("week_idx").size()
    i_by = iso.merge(cul[["culture_id", "week_idx"]], on="culture_id").groupby("week_idx").size()
    s_by = sus.merge(cul[["culture_id", "week_idx"]], on="culture_id").groupby("week_idx").size()
    has_ast = set(sus.isolate_id)
    iso_w = iso.merge(cul[["culture_id", "week_idx"]], on="culture_id")
    no_ast = iso_w[~iso_w.isolate_id.isin(has_ast)].groupby("week_idx").size()
    bad_res = sus[~sus.result.isin(["S", "R"])].merge(cul[["culture_id", "week_idx"]], on="culture_id") \
        .groupby("week_idx").size()
    for t in range(1, n_weeks + 1):
        trailing = c_by.loc[max(1, t - 8):t - 1]
        med = float(trailing.median()) if len(trailing) else float(c_by.loc[t])
        sub = x[(x.week_idx > t - 52) & (x.week_idx <= t)]
        first = sub.drop_duplicates(["patient_id", "organism", "specimen"])
        dedup = (sub.groupby(["organism", "specimen"]).size()
                 - first.groupby(["organism", "specimen"]).size()).fillna(0)
        top = sub.groupby(["organism", "specimen"]).size()
        dedup_detail = {f"{o}|{s}": [int(top[(o, s)]), int(top[(o, s)] - dedup[(o, s)])]
                        for (o, s) in top.index if top[(o, s)] >= 50}
        rows.append({
            "week_idx": t, "label": week_label(weeks, t),
            "cultures": int(c_by.get(t, 0)), "isolates": int(i_by.get(t, 0)), "ast_results": int(s_by.get(t, 0)),
            "rejected": 0,
            "intrinsic_flagged": int(dq["intrinsic_by_week"].get(t, 0)),
            "non_reportable": int(dq["nonreportable_by_week"].get(t, 0)),
            "volume_vs_median": round(float(c_by.get(t, 0)) / med, 2) if med else None,
            "isolates_without_ast": int(no_ast.get(t, 0)),
            "invalid_results": int(bad_res.get(t, 0)),
            "dedup_52w": dedup_detail,
        })
    return rows


# ----------------------------------------------------------------------------- main
def main():
    OUT.mkdir(parents=True, exist_ok=True)
    cul, iso, sus, pat, abx, wards, weeks = load()
    n_weeks = len(weeks)
    print(f"{n_weeks} weeks")
    x, markers, dq = build_isolate_table(cul, iso, sus, abx)
    n, r = window_counts(x, markers, n_weeks)

    print("detecting...")
    firings = [score(f) for f in detect(n, r, x, weeks, n_weeks)]
    print(f"  {len(firings)} firings")

    week_meta = []
    for _, w in weeks.iterrows():
        start = cul.loc[cul.week_idx == w.week_idx, "sample_date"].min()
        monday = (start - pd.Timedelta(days=start.weekday())).date().isoformat()
        week_meta.append({"week_idx": int(w.week_idx), "label": f"{w.iso_year}-W{w.iso_week:02d}",
                          "week_start": monday})

    series = {}
    for k in n:
        nn, rr = n[k], r[k]
        if nn.max() < 1:
            continue
        series["|".join(map(str, k))] = [nn.tolist(), rr.tolist()]

    organisms = sorted(x.organism.unique())
    ref = {
        "weeks": week_meta,
        "antibiotics": abx[["antibiotic_code", "antibiotic", "class", "reported_for"]].to_dict("records"),
        "wards": wards.to_dict("records"),
        "organisms": [{"organism": o, "enterobacterales": o in ENTEROBACTERALES} for o in organisms],
        "intrinsic": [{"organism": o, "antibiotic_code": a} for o, a in sorted(INTRINSIC)],
        "phenotypes": [{"code": p, "organisms": sorted(o)} for p, o in PHENOTYPES.items()],
    }
    (OUT / "ref.json").write_text(json.dumps(ref, ensure_ascii=False))
    # the series file is large, so it is stored gzipped and inflated server side
    with gzip.open(OUT / "series.json.gz", "wt", compresslevel=9) as fh:
        fh.write(json.dumps(series, separators=(",", ":")))
    (OUT / "firings.json").write_text(json.dumps(firings, separators=(",", ":"), ensure_ascii=False))
    (OUT / "quality.json").write_text(json.dumps(data_quality(cul, iso, sus, x, weeks, dq, n_weeks),
                                                 separators=(",", ":")))
    for f in OUT.glob("*.json*"):
        print(f"{f.name}: {f.stat().st_size / 1e6:.2f} MB")


if __name__ == "__main__":
    main()

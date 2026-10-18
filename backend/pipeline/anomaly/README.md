# Anomaly detection engine

Implements BUILD_PLAN section 7. Pure Python + pandas (no scipy); every statistic is in
`stats.py` and unit-tested.

```
python -m pipeline.anomaly --data ../data/tyks --from 85 --to 132 --out build/episodes.json
python -m pipeline.feeds --json build/episodes.json --out-dir build/feeds   # RSS, from the feeds branch
python -m pytest -q tests/anomaly                                           # ~20 s incl. ground truth
AMR_SLOW=1 python -m pytest -q tests/anomaly                                # + full replay false-alarm check (~2 min)
```

From the replay job (once `lab.*` exists), build the two input frames from the database and call:

```python
from pipeline.anomaly import Engine, build_episodes

engine = Engine(isolates, markers)  # frames described in data.py
alerts = engine.detect_week(cursor_week_idx)
```

## Input contract (`data.py`)

- `isolates`: `isolate_id, patient_id, week_idx, sample_date, organism, specimen, ward_code,
  setting (inpatient|ed|primary_care), onset (hospital|community|outpatient)`
- `markers`: `isolate_id, marker, resistant`, where `marker` is a WHONET code or `ESBL|MRSA|VRE|CPE`.

`load_csv_dir` builds both from the synthetic CSVs and applies the two cleaning rules the engine
depends on (EUCAST intrinsic pairs dropped, urine-only agents dropped outside urine). When
`clean.py` lands, read from `lab.*` with `is_intrinsic = false and reportable = true` instead.

## What runs each week t

| Signal | Rule |
|---|---|
| rate | Current = weeks t-3..t, baseline = the 52 weeks before it. First isolate per patient x species x specimen (x ward/setting for those scopes), de-duplicated separately in each window. Gate n >= 30 in both; below 30 the window widens to 8 then 13 weeks. Scopes: hospital, ward, setting, hospital-onset. %R per organism x specimen x agent, plus ESBL share (E. coli, K. pneumoniae) and MRSA share, also across all specimens. Hospital E. coli urine also gets a 1-week test. p0 floored at 0.5/n_b; exact binomial upper tail; BH across the week's tests; fires if q < 0.05 and (>= 5 pp or >= 1.5x). |
| count | Distinct patients with MRSA, ESBL or 3GC-R (CRO) Enterobacterales in 4 weeks, hospital and per ward. lambda = baseline patients / 52 x 4, floored at 0.5; Poisson upper tail; fires if p < 0.01 and k >= 3. |
| sentinel | Any new patient this week with CPE, VRE, meropenem-R Enterobacterales or blood MRSA (patients already positive in the previous 52 weeks do not re-fire; a CPE isolate is not repeated as meropenem-R). |
| drift | Every 4 weeks, hospital level: Cochran-Armitage trend over 13-week blocks of up to 3 years, BH-corrected; fires if q < 0.001 and >= 1 pp/year. Always low severity. |

Severity points, bands, confidence and rank follow section 7.5 exactly (`scoring.py`); the reasons
are stored in `evidence.severity_reasons`. Episodes (`episodes.py`) follow 7.6: same key in
consecutive weeks updates one episode, `escalated` when severity or confidence rises, `resolved`
after 2 quiet weeks.

## Output

`Alert.to_dict()` is the section 7.4 evidence JSON (one `agg.alert_firings.evidence` row), read by
both `pipeline.feeds` and the dashboard's `AlertEvidence` type:
`alert_id` (e.g. `A-2025W24-URO-ECOLI-URINE-ESBL`), `key, week_idx, week, type, organism, marker,
specimen, scope{type,value}, severity` (band), `severity_points, confidence, rank, rank_score, sentence,
current{weeks,window_weeks,n,x,pct,ci | k}, baseline{weeks,n,x,pct,ci | count,count_52w,expected_4w}`,
`expected{count}` (count alerts), `effect, test{name,p,q}, rule, distinct_patients, isolate_count,
breakdown{onset,specimen,ward}, co_resistance, hospital_onset_share, severity_reasons`. No patient or
isolate ids, no dates finer than the ISO week. `Episode.to_dict()` is an `agg.alert_episodes` row with
the dashboard's `api.alerts` columns (`alert_id, opened_week_idx, last_fired_week_idx, headline, ...`);
`Episode.to_feed_dict()` adds its firings, the shape `pipeline.feeds` reads.

## Results on the synthetic dataset (weeks 56-156)

- **Urology ESBL E. coli**: Critical/High-confidence count alert from 2025-W23 (outbreak week 1),
  Urology ESBL share rate alert from W24 (31% vs 3%, then 48% of 46 at W26). Hospital-wide E. coli
  urine ciprofloxacin fires at W25-W26 (14.7% vs 8.2%) as the secondary signal. Episodes resolve
  after W29.
- **ICU MRSA**: blood MRSA sentinel 2026-W10, Critical/High ICU MRSA count alert from W11
  (6 patients vs 0.5 expected, 13 by W13). Top-ranked alert in the hospital at W13.
- **Trimethoprim drift**: urinary E. coli trimethoprim, about 2.2 pp/year (16.9% to 20.2%), low.
- **False-alarm burden** outside the outbreak weeks: about 3 medium-or-higher alerts a month,
  1.7 new medium-or-higher episodes a month (plan target: "a handful per month, not dozens").

## Known limitations / open choices

- A widened 13-week window keeps the ICU MRSA rate alert firing until 2026-W22, after the cluster
  ends; the count alert resolves on time. Ranking still puts it below fresh signals.
- ESBL and 3GC-R count alerts largely overlap (most ESBL isolates are ceftriaxone-R), so the inbox
  shows both. Easy to drop 3GC-R counts if the team prefers.
- Section 7.5's points make several small ward count clusters "critical" with medium confidence
  (e.g. 5-6 patients with 3GC-R Enterobacterales in MED-A/GER in spring 2025); rank weights them down.
- Drift uses Cochran-Armitage rather than the plan's 52-vs-52 z-test + CUSUM: the 52-vs-52 test
  could not see the ~1.7 pp/year trimethoprim rise.
- Runtime is about 1 s per simulated week on a laptop.

# AMR Watch: hackathon build plan

A continuously updated, laboratory-based antimicrobial resistance surveillance tool for a Finnish
hospital laboratory (JunctionX Turku, Tyks x Mylab case "Antibiotic efficacy indicator").

Written 2026-10-17 for the build team. Dataset facts come from the data profile at
[`analysis/data_profile/README.md`](../analysis/data_profile/README.md); where this plan quotes a
number, that profile is the source.

---

## 0. One-paragraph pitch

Tyks compiles resistance reports once a year at hospital level, which is too coarse and too late for
a doctor choosing empiric therapy on their own ward. AMR Watch ingests laboratory results every week,
applies the surveillance rules a microbiologist would (first isolate per patient, intrinsic
resistance removed, at least 30 isolates before a percentage), shows **the last four weeks next to the
annual baseline** for any ward, specimen, organism and antibiotic, and runs an **anomaly engine** that
separates real signals from small-sample noise, explains every alert in numbers, ranks them, and
publishes them to an **RSS feed** clinicians can subscribe to. National and European rates (THL,
ECDC, WHO GLASS) sit alongside as benchmarks. An optional AI assistant answers questions using only
the computed results, with links to the evidence.

The judging criteria are understanding of the challenge, fit to the brief, usability, and the ability
to detect deviations and anomalies. Every section below is written to score on one of those four.

---

## 1. Goals and users

### Goals

1. **Continuously updated.** New lab results flow in on a schedule and every view reflects them
   without manual work. In the hackathon this is a week-by-week replay of the 156-week dataset.
2. **Trustworthy numbers.** Every rate follows CLSI M39 cumulative antibiogram rules and shows its
   denominator and confidence interval. Too-small samples are suppressed, never shown as a bare %.
3. **Local and current.** Four-week rates per ward next to the 52-week baseline, as the brief asks.
4. **Detects anomalies, explains them.** The core differentiator.
5. **Pushes, not only pulls.** Alerts reach people through an RSS feed, not only when they open the app.
6. **Contextualised.** Local rates are compared with Finnish and European benchmarks.

### Users and the views that serve them

| User | What they need | Primary views |
|---|---|---|
| **Clinical microbiologist** (investigator) | Spot emerging resistance, compare organisms and antibiotics, dig into unusual results | B Anomaly engine, C Exploration, D Assistant |
| **Stewardship team / clinician** (decision support) | Current, trustworthy susceptibility for empiric therapy and policy, for *their* ward | A Overview (ward antibiogram), RSS feed |
| **Hospital / public-health decision-maker** (strategist) | Trends, burden, how we compare nationally | A Overview trends, C historical view, benchmark overlays |
| **Lab data steward** (data quality owner) | Confidence that each weekly load is complete and correctly cleaned | Data quality page, pipeline run log |

The data steward is a fourth persona added to the brief's three: someone has to own the de-duplication
and exclusion rules, and showing them in the UI is how the team proves the numbers are trustworthy.

---

## 2. Architecture

```
 synthetic CSVs (the "LIS export")             ECDC Atlas / THL / WHO GLASS exports
          │  one-time seed                                  │  benchmark job (monthly / on demand)
          ▼                                                 ▼
 Supabase: staging.*  (all 156 weeks, untouched)     bench.rates (annual national / EU rates)
          │  weekly replay job: cursor += 1 week
          ▼
 Supabase: lab.*  (results "received so far", cleaned + flagged)
          │  aggregation job (Python): first-isolate, exclusions, windows, Wilson CI
          ▼
 Supabase: agg.*  (rates per window × organism × antibiotic × specimen × ward/setting)
          │  anomaly job (Python)
          ▼
 Supabase: agg.alerts (+ explanation JSON)  ──► feed job ──► feeds/*.xml in Supabase Storage (RSS)
          │
          ▼
 api.* views (read-only, aggregate only) ──► Next.js dashboard (A, B, C, quality)
                                          └─► AI assistant tools (D)
```

Everything from the replay onward runs as one GitHub Actions job per simulated week, in this order:
**advance cursor → clean → aggregate → detect → publish feed → log run**. The dashboard and the
assistant only ever read the `api` views; patient-level tables are never exposed to the browser.

### Repository layout (single monorepo)

```
amr-watch/
├─ data/raw/                 # the synthetic CSVs (synthetic, no real patients, ~21 MB)
├─ data/fixtures/            # tiny hand-built CSVs for unit tests
├─ supabase/migrations/      # SQL: schemas, tables, views, RLS, grants
├─ pipeline/                 # Python package
│  ├─ seed.py                # load CSVs into staging.*
│  ├─ replay.py              # move the next ISO week staging → lab
│  ├─ clean.py               # rules: intrinsic R, urine-only, onset, first-isolate keys
│  ├─ aggregate.py           # window rates + Wilson CI → agg.rates
│  ├─ detect.py              # anomaly engine → agg.alerts
│  ├─ feed.py                # RSS generation + upload
│  ├─ benchmarks/            # ecdc.py, thl.py, glass.py, mapping.csv
│  └─ stats.py               # wilson(), exact binomial / Poisson tests, BH correction
├─ tests/                    # pytest, incl. planted-outbreak ground-truth test
├─ web/                      # Next.js app
└─ .github/workflows/        # ci.yml, replay.yml, benchmarks.yml, migrate.yml
```

---

## 3. Ingestion pipeline

### 3.1 The local lab feed: weekly replay

The dataset covers **2023-10-02 to 2026-09-27, 156 ISO weeks with no gaps** (2023-W40 to 2026-W39).
We treat it as the laboratory information system's export and release it one week at a time.

- **Week index.** Every culture gets `week_idx` 1 to 156 (`2023-W40` = 1, `2024-W40` = 53,
  `2025-W23` = 88, `2026-W10` = 127, `2026-W39` = 156). Computed once in the seed step from
  `iso_year`/`iso_week`.
- **Seed (once).** `pipeline/seed.py` bulk-loads all five CSVs into `staging.*` with `COPY` over a
  direct Postgres connection. Staging is never modified afterwards.
- **Cursor.** A single-row table `lab.replay_state(cursor_week_idx, updated_at, run_id)`.
- **Advance.** `replay.py --advance N` copies cultures with `week_idx` in `(cursor, cursor+N]` and their
  isolates and susceptibility rows from `staging` to `lab`, inside one transaction, then moves the
  cursor. It is idempotent: re-running the same step inserts nothing new (`on conflict do nothing`).
- **Reset.** `replay.py --reset-to 85` truncates `lab.*`, `agg.*` and alerts, then backfills weeks
  1..85 in one go (aggregates and detection are recomputed for each backfilled week so the alert
  history is complete).
- **Starting point.** The 52-week baseline needs history, so the replay never starts before week 56
  (2024-W43). For the demo we start at **week 85 (2025-W20)**, three weeks before the Urology outbreak.
- **Simplification to state on the slide.** Results are released in the week the sample was taken.
  Real culture and AST results arrive 2 to 4 days later; a stretch goal is a configurable reporting lag.

### 3.2 Cleaning and standardisation (applied on the way into `lab.*`)

Each rule is a pure function in `clean.py`, unit-tested on fixtures, and its effect is counted per
run in `lab.dq_log` so the data steward can see it.

| # | Rule | Why | Implementation |
|---|---|---|---|
| R1 | **Exclude intrinsic resistance** | Present in the data despite the README; all 100% R and would inflate %R and the heatmap | `ref.intrinsic_resistance` (EUCAST expected phenotypes), seeded with *K. pneumoniae*–AMP, *K. oxytoca*–AMP, *C. freundii*–AMP, *P. mirabilis*–NIT. Rows matching are kept but flagged `is_intrinsic = true` and excluded from every rate. The heatmap shows these cells as "IR". |
| R2 | **Urine-only agents for urine only** | Mecillinam, trimethoprim, nitrofurantoin are only reported for urine (`antibiotics.reported_for`) | Flag `reportable = false` if agent is urine-only and specimen is not urine. Profile found none, but the rule guards future loads. |
| R3 | **Hospital-onset flag** | Hospital-acquired = sampled on day 3 or later of admission | `onset = 'hospital'` if `ward_type = 'in'` and `sample_date - admission_date >= 2` (admission day = day 1); `'community'` for inpatients sampled on day 1–2; `'outpatient'` when `admission_date` is blank (ED, health centres). |
| R4 | **First-isolate key** | CLSI M39: first isolate per patient per species per specimen per period | Store `(patient_id, organism, specimen, sample_date, isolate_id)`; de-duplication itself happens in aggregation, **per reporting window**, because it depends on the window. |
| R5 | **Setting** | Inpatient vs ED vs primary care differ (trimethoprim R 22.3% vs 15.4% vs 16.4%) | `setting` from `ward_type` + `institution`: `inpatient`, `ed`, `primary_care`. |
| R6 | **Code standardisation** | Organisms are Latin names, not WHONET codes | `ref.organisms(name, short_name, whonet_code, gram, group)`; antibiotics already carry WHONET codes. Unknown organism or code → row goes to `lab.rejects` and is counted, not silently dropped. |
| R7 | **Derived fields** | Filters and demographic splits | `age_band` (0–17, 18–64, 65–79, 80+), `sex` from patients. |
| R8 | **Validation checks** | Catch a broken export | Expected volume (alert if a week has < 50% of the trailing median), every isolate has susceptibility rows, every result in {S, R}, no future dates. Failures are written to `lab.dq_log` and shown on the quality page; a hard failure stops the run before aggregation. |

**De-duplication matters.** First-isolate per period removes **28% of the E. coli urine denominator**
(81% of patients have repeat cultures). De-duplicating per week instead of per window removes only
0.4%, so the weekly replay would over-count repeat patients against the yearly baseline. Aggregation
therefore always de-duplicates within the window being reported (4 weeks, 52 weeks, and so on).

### 3.3 The benchmark layer: ECDC, THL, WHO GLASS (separate job)

National and European sources publish **annual, aggregate** rates. They have no ward or weekly data and
little specimen detail beyond invasive vs urine, so they are context, not a feed. They refresh roughly
once a year, so the job runs monthly and on demand and only upserts when the source has a new year.

| Source | What we take | How | Caveat to show in the UI |
|---|---|---|---|
| **ECDC Surveillance Atlas (EARS-Net)** | %R and n per country per year for Finland and EU/EEA for *E. coli*, *K. pneumoniae*, *P. aeruginosa*, *S. aureus* (MRSA), enterococci | The Atlas's built-in CSV export for the chosen indicators, committed as `pipeline/benchmarks/raw/ecdc_atlas_<date>.csv` and parsed by `ecdc.py` | EARS-Net covers **invasive isolates (blood/CSF) only**, so compare with our blood annual rates, not urine. EARS-Net VRE is *E. faecium*; our data has only *E. faecalis*, so no VRE benchmark. |
| **THL (Finres / national AMR statistics)** | Finnish annual %R including urinary *E. coli* | THL open data API (JSON-stat cubes) if an AMR cube is published; otherwise the Finres report tables transcribed once into `thl_finres_<year>.csv` | Best comparator for urine (Finland, same breakpoints). |
| **WHO GLASS** | Finland and comparator-country rates for GLASS pathogen–drug combinations | The dashboard's own data download or the GLASS report annex, saved as CSV. **Do not scrape the Shiny app**: its URL contains session tokens and changes. | Different case definitions and coverage; label as "global context". |

**Hour-one task for the benchmark owner:** confirm each download route works and record the exact
URL or export steps in `pipeline/benchmarks/SOURCES.md`. If any automated route fails, a committed CSV
plus parser is an acceptable hackathon fallback: the job still validates and upserts it, and the UI
still shows source and year.

**Mapping.** `pipeline/benchmarks/mapping.csv` maps our organism + WHONET code to the benchmark's
antimicrobial group: CRO → third-generation cephalosporins, CIP → fluoroquinolones,
AMP → aminopenicillins, MEM → carbapenems, FOX → MRSA, TZP → piperacillin-tazobactam,
CAZ → ceftazidime. Rows without a mapping get no benchmark line, rather than a misleading one.

---

## 4. Supabase data model

Five schemas. Only `api` is exposed through Supabase's REST API (add it under
*Settings → API → Exposed schemas*); the rest are private.

| Schema | Holds | Who reads |
|---|---|---|
| `staging` | Raw CSVs, all 156 weeks | Replay job only |
| `lab` | Results released so far, cleaned and flagged; replay state; data-quality log | Pipeline only |
| `ref` | Organisms, antibiotics, wards, intrinsic resistance, alert rules config | Pipeline; selected columns via `api` |
| `bench` | Benchmark rates | Pipeline; via `api` |
| `agg` | Window rates, alerts, alert episodes, feed log | Pipeline; via `api` |
| `api` | Read-only views over `agg`, `bench`, `ref` (aggregate only) | Dashboard (anon key), assistant |

### 4.1 Core tables (abridged)

```sql
-- lab: one row per released culture / isolate / AST result
create table lab.cultures (
  culture_id text primary key, patient_id text not null,
  sample_date date not null, week_idx int not null, iso_year int, iso_week int,
  ward_code text references ref.wards, setting text, specimen text,
  admission_date date, onset text, age_years int, age_band text, sex text,
  result text, n_isolates int
);
create table lab.isolates (
  isolate_id text primary key, culture_id text references lab.cultures,
  organism text references ref.organisms, quantity text,
  esbl bool, mrsa bool, vre bool, cpe bool
);
create table lab.susceptibility (
  isolate_id text references lab.isolates, antibiotic_code text references ref.antibiotics,
  result char(1) check (result in ('S','R')), guideline text,
  is_intrinsic bool not null default false, reportable bool not null default true,
  primary key (isolate_id, antibiotic_code)
);
create table lab.replay_state (id int primary key default 1, cursor_week_idx int, updated_at timestamptz, run_id text);
create table lab.dq_log (run_id text, week_idx int, check_name text, value numeric, status text, detail text);

-- ref
create table ref.intrinsic_resistance (organism text, antibiotic_code text, source text, primary key (organism, antibiotic_code));

-- bench
create table bench.rates (
  source text, country text, year int, organism text, antimicrobial_group text,
  specimen_scope text,             -- 'invasive' | 'urine' | 'all'
  n_tested int, pct_r numeric, ci_low numeric, ci_high numeric,
  retrieved_at timestamptz, source_url text,
  primary key (source, country, year, organism, antimicrobial_group, specimen_scope)
);
```

### 4.2 Aggregate tables written by the pipeline

Rates need window-specific de-duplication, which is awkward and slow as a live SQL view, so the
aggregation job materialises them into tables and the `api` views are thin selects on top.

```sql
create table agg.rates (
  end_week_idx int, window_weeks int,          -- 1, 4, 8, 13, 52
  organism text, antibiotic_code text,         -- antibiotic_code may be a phenotype: 'ESBL','MRSA','VRE','CPE'
  specimen text,                               -- 'urine' | 'blood' | 'wound' | 'all'
  scope_type text, scope_value text,           -- ('hospital','ALL') | ('ward','URO') | ('setting','primary_care') | ('onset','hospital')
  n_tested int,                                -- first isolates tested (denominator)
  n_resistant int,                             -- numerator
  pct_r numeric, wilson_low numeric, wilson_high numeric,
  reportable bool,                             -- n_tested >= 30
  primary key (end_week_idx, window_weeks, organism, antibiotic_code, specimen, scope_type, scope_value)
);
-- optional exploration splits (sex, age_band) live in agg.rates_demo with the same shape, 52-week window only.
```

Size check: about 60 reportable organism–antibiotic–specimen combinations × 5 windows × ~15 scopes ×
156 weeks is roughly 700k rows, well inside Supabase's free tier. Each replay step adds about 4,500.

**Wilson interval** (95%, z = 1.96), in `stats.py` and mirrored as a SQL function for ad hoc checks:

```
centre = (p + z²/2n) / (1 + z²/n)
half   = z·sqrt(p(1−p)/n + z²/4n²) / (1 + z²/n)
```

### 4.3 Read views (`api` schema)

| View | Purpose | Key columns |
|---|---|---|
| `api.current_vs_baseline` | Section A tiles: last 4 weeks vs 52 weeks at the cursor, per combination and scope | 4w n, x, %R, CI; 52w n, x, %R, CI; delta; `reportable_4w`; auto-widened window if 4w < 30 |
| `api.rate_series` | Trend charts | end_week, window, n, %R, CI |
| `api.antibiogram` | Ward antibiogram table (%S and %R) | organism × antibiotic × ward, 4w and 52w |
| `api.heatmap` | Section C heatmap | organism × antibiotic, chosen window and scope, intrinsic flagged |
| `api.ward_comparison` | Forest plot across wards | per ward %R + CI, hospital line |
| `api.alerts` / `api.alert_detail` | Section B and RSS | see §7 |
| `api.benchmarks` | Overlay lines | mapped to our organism + code |
| `api.data_quality` | Quality page | per-run counts, checks, exclusions |
| `api.replay_status` | "Data through 2025-W24" banner | cursor, last run time, status |

**Security.** Row Level Security is enabled on every table. The `anon` role gets `select` on `api.*`
only. Views are created by the owner role, so they can read `agg` without exposing it. The service
role key is used only inside GitHub Actions. No `api` view returns a `patient_id`, birth year or exact
sample date: the smallest time unit exposed is the ISO week.

---

## 5. GitHub Actions (CI/CD)

### 5.1 Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | Pull request, push to `main` | `ruff` + `pytest` for the pipeline; `tsc`, `eslint`, `next build` for the web app; parses a generated test feed with `feedparser` |
| `migrate.yml` | Push to `main` touching `supabase/migrations/**` | `supabase db push` with the Supabase CLI |
| `replay.yml` | `schedule` + `workflow_dispatch` | Advance → clean → aggregate → detect → feed → log (one job, steps in order) |
| `benchmarks.yml` | Monthly `schedule` + `workflow_dispatch` | Fetch or parse each source, validate, upsert `bench.rates`, log what changed |
| Web deploy | Vercel GitHub integration | Preview per PR, production on `main` |

### 5.2 `replay.yml` outline

```yaml
on:
  schedule:
    - cron: "0 * * * *"        # during the event: one simulated week per hour
  workflow_dispatch:
    inputs:
      advance:  { description: "Weeks to advance", default: "1" }
      reset_to: { description: "Reset cursor to week_idx (blank = no reset)", default: "" }
concurrency: { group: replay, cancel-in-progress: false }   # never two replays at once
jobs:
  replay:
    runs-on: ubuntu-latest
    environment: supabase-prod
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12", cache: pip }
      - run: pip install -r pipeline/requirements.txt
      - run: python -m pipeline.run --advance "${{ inputs.advance || 1 }}" --reset-to "${{ inputs.reset_to }}"
        env:
          SUPABASE_DB_URL: ${{ secrets.SUPABASE_DB_URL }}
          SUPABASE_URL: ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          APP_BASE_URL: ${{ vars.APP_BASE_URL }}
```

GitHub's scheduler can run several minutes late and has a five-minute minimum, so the **live demo uses
`workflow_dispatch`** (or `python -m pipeline.run --advance 1` from a laptop) rather than waiting for
cron. In a real deployment the cron would be daily or weekly after the LIS export.

### 5.3 Secrets

| Secret | Where | Used for |
|---|---|---|
| `SUPABASE_DB_URL` (pooler connection string) | GitHub environment `supabase-prod` | Bulk `COPY` and transactional replay |
| `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` | GitHub environment | Storage upload of feed files |
| `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROJECT_REF`, `SUPABASE_DB_PASSWORD` | GitHub environment | `supabase db push` in `migrate.yml` |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Vercel env | Browser reads of `api.*` |
| `ANTHROPIC_API_KEY` | Vercel env, server-side only | AI assistant route |

Rules: the service role key never goes to Vercel or the browser; secrets are never echoed in logs; a
`.env.example` documents every variable without values; `gitleaks` runs in `ci.yml`.

### 5.4 Tests that matter

- `clean.py`: intrinsic pairs flagged; urine-only agents on a wound isolate flagged; onset day 1, 2, 3
  edges; unknown organism goes to rejects.
- First-isolate: a patient with three E. coli urine isolates in one 4-week window counts once; in two
  different windows counts once in each.
- `stats.py`: Wilson against known values (e.g. 0/30, 15/30, 30/30); exact binomial and Poisson tails;
  BH correction.
- Aggregation regression: hospital-wide first-isolate E. coli urine ciprofloxacin over the full 3 years
  equals **8.4%** (n = 7,657), trimethoprim **18.4%**, matching the profile.
- **Ground truth:** running detection over the full dataset fires a high-severity alert for URO ESBL
  E. coli by 2025-W26 and for ICU MRSA by 2026-W12 (see §7.6). This test is the team's proof that the
  engine works.

---

## 6. Dashboard

### 6.1 Stack

**Next.js (App Router, TypeScript) + Tailwind + shadcn/ui + Apache ECharts, deployed on Vercel, reading
Supabase with `@supabase/supabase-js`.**

Why: every filter state lives in the URL, so an RSS item or an assistant answer can deep-link to an
exact drill-down; ECharts handles heatmaps, confidence bands and dual axes without custom drawing;
server route handlers host the assistant (keeping the API key off the browser) and an app-served copy
of the feed; Vercel previews each PR for free. Usability is a judging criterion, and a polished,
fast, linkable UI is easier here than in Streamlit.

*Fallback if the frontend owner is unavailable:* Streamlit reading the same `api` views. The data layer
is unchanged, so the switch costs only UI time.

### 6.2 Global elements

- **Replay banner:** "Data through 2025-W24 · updated 14:00 · 156 isolates this week" from
  `api.replay_status`, with a pulse when a new week lands (Supabase Realtime on `lab.replay_state`, or
  polling every 30 s).
- **Global filter bar** (persisted in the URL): ward (multi), setting (inpatient / ED / primary
  care), specimen (urine / blood / wound), organism, antibiotic, window (4 weeks / 13 weeks / 52
  weeks / custom), onset (hospital / community / outpatient).
- **Honest numbers everywhere:** each percentage shows `n` and its CI. When `n < 30` the value is
  replaced by "n = 17, too few for a %" and a one-click "widen to 13 weeks" button. Urine-only agents
  disappear from the antibiotic picker when specimen is blood or wound.
- **%S / %R toggle.** Clinicians choosing therapy think in susceptibility; surveillance thinks in
  resistance. Default %S on the antibiogram, %R elsewhere.

### 6.3 A. Surveillance overview (stewardship, decision-maker)

| Element | Content | Data |
|---|---|---|
| KPI tiles (one per pinned combination; defaults: E. coli urine CIP, TMP, MEC, NIT; E. coli blood CRO; S. aureus MRSA share) | 4-week %R with CI, 52-week %R with CI, change in percentage points with an up/down arrow coloured only when CIs do not overlap, eligible isolates `n` | `api.current_vs_baseline` |
| Trend chart | Bars = first isolates tested per week (right axis); line = rolling %R with Wilson band; dashed line = 52-week baseline; dotted line = THL/ECDC national annual rate where mapped | `api.rate_series`, `api.benchmarks` |
| **Ward antibiogram** | Organism rows × antibiotic columns, %S for the last 4 weeks with the 12-month value beneath; cells with n < 30 greyed with the count shown | `api.antibiogram` |
| Open alerts strip | Top three alerts for the current filter, linking to B | `api.alerts` |

Volume guidance from the profile drives the defaults: E. coli urine is shown weekly; S. aureus wound,
K. pneumoniae urine and E. faecalis urine at 4 weeks; Proteus and Pseudomonas at 8–13 weeks; blood only
as 52-week rates. For ICU and Surgery, ward-level E. coli urine never reaches 30 even quarterly, so
those wards show counts, not percentages.

### 6.4 B. Anomaly detection engine (microbiologist, stewardship)

- **Alert inbox:** cards sorted by rank (§7.5). Each card shows severity badge, confidence, the
  one-sentence explanation, a sparkline of the last 26 weeks with the trigger window shaded, ward and
  specimen chips, and status (New, Acknowledged, Dismissed with a note). Filters: severity, alert type
  (rate / count / sentinel / drift), ward, organism, status.
- **Alert detail page** `/alerts/[id]`:
  - "Why this fired" table: current window x/n, %R, CI; baseline x/n, %R, CI; difference; test and
    p/q value; rule that fired; thresholds in force.
  - Trend chart with trigger window highlighted.
  - Breakdown of the trigger window by ward, specimen and onset, so the user sees where it comes from.
  - Co-resistance profile of the flagged isolates (e.g. "of 33 ESBL isolates, 91% CIP-R, 85% TMP-R").
  - Distinct patients involved (a count, not identities), which separates one patient re-sampled from
    a spreading cluster.
  - "Explore in C" button carrying the filters across.
- **Engine transparency panel:** the active thresholds (minimum n, windows, alpha, count rules) in
  plain language, and a validation card showing the two planted outbreaks were detected and when.

### 6.5 C. Resistance exploration (microbiologist, decision-maker)

| View | Detail |
|---|---|
| Organism × antibiotic **heatmap** | %R colour scale for the chosen window and scope; hatched where n < 30; "IR" in grey for intrinsic pairs; "—" where not tested. Click a cell to drill down. |
| **Ward comparison** (forest plot) | One row per ward: %R with Wilson CI and n, vertical line at the hospital rate; wards below n = 30 listed with counts only. |
| **Specimen breakdown** | Small multiples of the same combination for urine, wound, blood. |
| **Historical explorer** | Annual first-isolate %R for Y1, Y2, Y3 (e.g. trimethoprim 16.4 → 18.6 → 20.0%) with benchmark overlays; free date range. |
| Population splits | Sex (urinary E. coli CIP 5.9% women vs 12.5% men), age band, setting, onset. |
| Drill-down | From an alert or a heatmap cell to a pre-filtered trend + forest plot + breakdown, all aggregate. |

Stretch: a pseudonymised isolate line list for the microbiologist role behind Supabase Auth, served by a
separate view that requires an authenticated role. Out of scope for the MVP.

### 6.6 Data quality page (data steward)

Per replay run: rows released, rows rejected and why, intrinsic results excluded, first-isolate
de-duplication removed (by organism/specimen), validation checks passed or failed, run duration and
GitHub run link. This is where the team shows judges that the rules from §3.2 are actually applied.

### 6.7 D. AI investigation assistant

A chat drawer available on every page. Design in §9.

---

## 7. Anomaly detection engine

Results are S/R only, with no MIC, so every signal is a **proportion** or a **count**.

### 7.1 What is monitored each week

| Signal family | Units | Scopes |
|---|---|---|
| **Rate signals** | %R for each reportable organism–antibiotic–specimen combination, and phenotype shares (ESBL among E. coli and K. pneumoniae, MRSA among S. aureus) | Hospital, each ward, each setting, hospital-onset |
| **Count signals** | Number of MRSA, ESBL, 3GC-R or CPE isolates; any isolate from blood with a priority phenotype | Hospital, each ward |
| **Sentinel events** | Any CPE, any VRE, any meropenem-R Enterobacterales, any blood MRSA | Immediate, no baseline needed |
| **Drift signals** | Slow change across years | Hospital, by specimen |

### 7.2 Windows and the 30-isolate gate

- **Current window:** the trailing 4 weeks ending at the cursor (weeks t−3..t).
- **Baseline:** the 52 weeks *before* the current window (weeks t−55..t−4), so the outbreak does not
  dilute its own baseline.
- First-isolate de-duplication is applied separately within the current window and within the
  baseline.
- **Gate:** a rate test runs only if the current window has **n ≥ 30** first isolates and the baseline
  has n ≥ 30. If the 4-week window is too small, the engine tries 8 and then 13 weeks; if still below 30,
  the combination is handled by the count rule instead.
- **E. coli urine at hospital level** additionally runs a **1-week** test, since it clears 30 every
  week (median 68), giving true weekly detection for the commonest combination.

### 7.3 Tests

**Rate signal** (one-sided, "is resistance higher than baseline?"):

1. Baseline proportion p₀ = x_b / n_b, floored at 0.5 / n_b so a zero baseline does not make any single
   resistant isolate infinitely surprising.
2. Exact binomial upper-tail p-value of observing ≥ x_c resistant in n_c given p₀.
3. **Benjamini–Hochberg** across all rate tests run that week → q-value. With hundreds of
   combination × scope tests per week, some hits are expected by chance (the profile's quick scan found
   several 3–5 isolate blips); BH keeps the false discovery rate in check.
4. Wilson 95% intervals for both windows are reported alongside, and a **minimum effect** is required:
   absolute increase ≥ 5 percentage points *or* relative increase ≥ 1.5×.
5. Fires if q < 0.05 and the minimum effect holds.

**Count signal** (rare, serious organisms where percentages are unstable):

1. Expected count in 4 weeks λ = (baseline count / 52) × 4, floored at 0.5.
2. Poisson upper-tail p-value of observing ≥ k.
3. Fires if p < 0.01 **and** k ≥ 3, or immediately as a sentinel for the events in §7.1.

**Drift signal:** compares the most recent 52-week first-isolate rate against the previous 52 weeks
(two-proportion z-test) and tracks a one-sided CUSUM on monthly rates. Expected to pick up the
trimethoprim rise in urinary E. coli (about 15% to 20% over three years). Always low severity,
informational.

### 7.4 Alert explanation

Every alert stores a structured `evidence` JSON and a generated sentence. Nothing in the sentence is
free text from a model; it is a template filled from the JSON.

```json
{
  "alert_id": "A-2025W25-URO-ECOLI-URINE-ESBL",
  "type": "rate",
  "organism": "Escherichia coli", "marker": "ESBL", "specimen": "urine",
  "scope": {"type": "ward", "value": "URO"},
  "current":  {"weeks": "2025-W22..2025-W25", "n": 41, "x": 14, "pct": 34.1, "ci": [21.6, 49.4]},
  "baseline": {"weeks": "2024-W22..2025-W21", "n": 352, "x": 14, "pct": 4.0, "ci": [2.4, 6.6]},
  "effect":   {"abs_pp": 30.1, "ratio": 8.5},
  "test":     {"name": "exact binomial, one-sided", "p": 1e-9, "q": 4e-8},
  "distinct_patients": 14,
  "breakdown": {"onset": {"hospital": 11, "community": 3}},
  "co_resistance": {"CIP": 0.91, "TMP": 0.85},
  "rule": "rate: q<0.05 and abs>=5pp, n_current>=30",
  "evidence_url": "/alerts/A-2025W25-URO-ECOLI-URINE-ESBL"
}
```

*(Values above illustrate the shape; the real numbers come from the engine.)*

> **Urology, urine, E. coli: ESBL share rose to 34.1% (14 of 41, 95% CI 21.6–49.4%) in the last
> 4 weeks, against 4.0% (14 of 352) in the previous 52 weeks. 14 different patients, 11 hospital-onset.**

### 7.5 Severity, confidence and ranking

**Confidence** (how sure we are the change is real) comes from the statistics:

| Confidence | Rate signal | Count signal |
|---|---|---|
| High | q < 0.001 and n_current ≥ 50 | p < 0.001 and k ≥ 5 |
| Medium | q < 0.01 | p < 0.01 |
| Low | q < 0.05 | sentinel with no baseline, or k = 3 |

**Severity** (how much it matters clinically) is a points score:

| Factor | Points |
|---|---|
| Priority phenotype (CPE, carbapenem R, VRE, MRSA, ESBL / 3GC-R) | 3 |
| Blood isolate | 3 |
| First-line empiric agent for that specimen (e.g. TMP, MEC, NIT in urine; CRO in blood) | 2 |
| Absolute increase ≥ 15 pp, or count ≥ 3× expected | 2 |
| Hospital-onset majority | 1 |
| ≥ 5 distinct patients | 1 |

Severity bands: **Critical ≥ 7, High 5–6, Medium 3–4, Low ≤ 2**. Sentinel CPE is always at least High.

**Rank** = severity points × confidence weight (High 1.0, Medium 0.7, Low 0.4), ties broken by recency.
The inbox and the RSS feed use the same order.

### 7.6 Alert lifecycle

- Alerts are grouped into **episodes** by key (signal, organism, marker or antibiotic, specimen,
  scope). A key that fires in consecutive weeks updates the same episode rather than creating new
  alerts.
- Episode states: `open` → `escalated` (severity or confidence went up) → `resolved` (no firing for
  2 consecutive weeks). Users can mark `acknowledged` or `dismissed` with a note.
- Tables: `agg.alert_episodes(episode_id, key, opened_week, last_fired_week, status, severity,
  confidence, rank)` and `agg.alert_firings(episode_id, week_idx, evidence jsonb)`.

### 7.7 Validation against planted ground truth

| Planted event | Where / when | What the engine should do |
|---|---|---|
| **ESBL E. coli outbreak, Urology** | 2025-W23 to W29 (week_idx 88–94); ESBL share among E. coli + K. pneumoniae about 4% → 40% (23 of 57 at peak); 33 isolates, 33 patients; also lifts hospital-wide E. coli urine CIP from 8% to 14.5% | URO ESBL rate alert High/Critical by W25–26; hospital-wide E. coli urine CIP alert as a secondary signal; resolves after W31 |
| **MRSA cluster, ICU** | 2026-W10 to W13 (week_idx 127–130); 13 MRSA in 4 weeks vs about 1.4% baseline; wound and blood | ICU MRSA count alert High/Critical by W11–12; blood MRSA sentinels |
| **Trimethoprim drift** | Urinary E. coli, about 15% → 20% over three years | Low-severity drift alert |

Also measure the **false alarm burden**: total medium-or-higher alerts across the other ~150 weeks.
Target: a handful per month, not dozens. The smaller hits the profile scan found (MED-B ESBL 2024
W38–41, PHC-N K. pneumoniae CIP 2025 W13–14) should come out Low or Medium, which is a good thing to
show judges: the engine distinguishes "real signal" from "small sample".

Tune thresholds in a notebook once, freeze them in `ref.alert_rules`, and let the ground-truth test in
CI guard against regressions.

---

## 8. RSS feed alerts

Stewardship and ward clinicians should not have to open a dashboard to learn that resistance is rising
on their ward. Each confirmed alert is published as an item in a standard **RSS 2.0** feed, which they
can follow in Outlook, Thunderbird, Feedly, or a Teams or Slack channel through those tools' RSS
connectors.

### 8.1 Feeds

| Feed | URL (Supabase Storage public bucket `feeds`) | Contents |
|---|---|---|
| All alerts | `/storage/v1/object/public/feeds/alerts.xml` | Every alert episode event, Low and up |
| High priority | `.../feeds/alerts-high.xml` | High and Critical only (the one stewardship should subscribe to) |
| Per ward | `.../feeds/ward-URO.xml`, `ward-ICU.xml`, … | Alerts scoped to that ward, plus hospital-wide Critical |
| Per group | `.../feeds/mrsa.xml`, `esbl.xml`, `cpe.xml` | Phenotype-specific |

The app also serves `/feed.xml` and `/feed/[name].xml` as thin route handlers that redirect to the
Storage copy, so the URL users see is on the app's domain. A **Subscribe** button on the alerts page
and on each ward view copies the matching feed URL.

### 8.2 When an item is published

- An episode **opens** (first firing).
- An episode **escalates** (severity band or confidence goes up). This is a new item with the same
  `guid` prefix and a revision suffix, so readers see the update.
- An episode **resolves** (optional item, "returned to baseline"). Included in `alerts.xml`, excluded
  from `alerts-high.xml` to keep that feed quiet.
- Repeated firings at the same severity do **not** create new items. This keeps the feed readable.

### 8.3 Item contents

```xml
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:amr="https://amr-watch.example/ns">
<channel>
  <title>AMR Watch: high-priority resistance alerts</title>
  <link>https://amr-watch.vercel.app/alerts</link>
  <atom:link href="https://amr-watch.vercel.app/feed/alerts-high.xml" rel="self" type="application/rss+xml"/>
  <description>Weekly laboratory-based antimicrobial resistance alerts (synthetic hackathon data)</description>
  <lastBuildDate>Mon, 23 Jun 2025 06:00:00 +0000</lastBuildDate>
  <ttl>60</ttl>
  <item>
    <title>[HIGH] Urology · E. coli urine · ESBL share 34.1% (was 4.0%)</title>
    <link>https://amr-watch.vercel.app/alerts/A-2025W25-URO-ECOLI-URINE-ESBL?week=2025-W25</link>
    <guid isPermaLink="false">amr-watch:A-2025W25-URO-ECOLI-URINE-ESBL:r1</guid>
    <pubDate>Mon, 23 Jun 2025 06:00:00 +0000</pubDate>
    <category>severity:high</category>
    <category>ward:URO</category>
    <category>organism:Escherichia coli</category>
    <category>marker:ESBL</category>
    <description><![CDATA[
      Urology, urine, E. coli: ESBL share 34.1% (14/41, 95% CI 21.6–49.4%) in 2025-W22..W25
      vs 4.0% (14/352) in the previous 52 weeks. +30.1 pp. Confidence: high (q < 0.001).
      14 distinct patients, 11 hospital-onset. Opened 2025-W25.
      Aggregate surveillance signal for review; not individual treatment advice.
    ]]></description>
    <amr:severity>high</amr:severity>
    <amr:confidence>high</amr:confidence>
    <amr:window>2025-W22/2025-W25</amr:window>
  </item>
</channel>
</rss>
```

Required in every item: organism, antibiotic or marker, specimen, ward or scope, the current window,
before and after rate (or count and expected count), absolute change, severity, confidence, distinct
patient count, and a deep link to the alert's drill-down page with the week pinned so the link shows
the same numbers later. Times in `pubDate` are the replay run time; the ISO week is in the text.

### 8.4 Generation, hosting and cadence

- `pipeline/feed.py` runs as the last step of every replay run. It reads `agg.alert_episodes` and
  `agg.alert_firings`, keeps the newest 50 items per feed, renders XML with `feedgen` (or a small
  Jinja template), and uploads each file to the public `feeds` bucket with
  `Cache-Control: max-age=60`.
- `agg.feed_log(item_guid, feed, published_at)` records what was published, so items are never
  duplicated or silently changed.
- **Cadence:** one regeneration per replay step, so hourly during the hackathon (one simulated week per
  hour) and immediately on manual demo advances. In production: after each daily or weekly LIS export.
- **Validation:** `ci.yml` builds a feed from fixtures and parses it with `feedparser`, failing on any
  bozo error; before the demo, paste one URL into the W3C Feed Validator.

### 8.5 Privacy

Feeds are public URLs, so they carry **aggregate data only**: no patient IDs, no birth years, no exact
sample dates (ISO weeks only), no free-text clinical notes. Counts can be small (a single CPE is a
legitimate alert), which is acceptable for synthetic data; for a real deployment the feed would sit
behind hospital SSO or a tokenised URL, and the plan should say so on the slide.

---

## 9. AI investigation assistant (stretch)

### 9.1 Principles

1. It **retrieves, it does not compute**. Every number it says comes from a tool result.
2. It reads only the validated `api` views, through a **fixed set of typed tools**. No free-form SQL.
3. It **never gives individual patient treatment advice**. It can describe what the aggregate data
   shows and point to stewardship guidance.
4. Every claim links to the dashboard view that shows the evidence.

### 9.2 Implementation

A Next.js route handler (`/api/assistant`) calls the Claude API (a current model such as
`claude-sonnet-5-5`) with tool use. The API key stays server-side. Tools are thin wrappers over
Supabase queries on `api.*`, each returning data **plus an `evidence_url`**:

| Tool | Arguments | Returns |
|---|---|---|
| `list_alerts` | period, min_severity, ward?, organism?, status? | Ranked alerts with evidence JSON |
| `get_alert` | alert_id | Full evidence and breakdowns |
| `get_rate` | organism, antibiotic_or_marker, specimen, scope, window_weeks, end_week? | n, x, %R, Wilson CI, reportable flag |
| `compare_windows` | same + baseline window | Current vs baseline with difference |
| `get_trend` | combination, scope, from_week, to_week, window_weeks | Series |
| `compare_wards` | combination, window | Forest-plot rows |
| `get_benchmark` | organism, antibiotic, year? | THL / ECDC / GLASS rates with source |
| `list_combinations` | specimen? | What is tested and reportable |
| `get_data_status` | none | Replay cursor, last run, data-quality summary |

**Guardrails:**

- System prompt states the four principles, the replay week, and that n < 30 must be reported as
  "too few isolates for a percentage".
- **Number grounding check:** after the model answers, the server extracts every number from the reply
  and checks it appears in (or rounds from) a tool result in that turn. Any unmatched number triggers
  one regeneration with a correction note; if it still fails, the answer is shown with the unverified
  figure flagged.
- A classifier step (or simple prompt rule plus keyword check) catches patient-specific requests
  ("my patient in bed 4 has…, what should I give?") and returns a fixed response pointing to the
  ward antibiogram and local stewardship guidance.
- Answers render evidence links as buttons to the exact dashboard view.

### 9.3 Example questions

| Question | Tools called | Shape of the answer |
|---|---|---|
| "Which combinations have shown unusual increases this month?" | `list_alerts(period=last 4 weeks)` | Ranked list, each with before/after numbers, severity, confidence and a link to its alert page |
| "Is trimethoprim still a reasonable empiric choice for cystitis in the health centres?" | `get_rate` for E. coli urine TMP at primary care, 4 and 52 weeks; `get_benchmark` | "Primary-care urinary E. coli trimethoprim resistance is X% (n, CI) over the last 4 weeks vs Y% last year; Finnish national rate Z%." Plus the reminder that the choice belongs to local guidelines. No patient advice. |
| "Why did the Urology alert fire?" | `get_alert` | Reads the evidence JSON in plain language, including distinct patients and co-resistance |
| "Compare ICU and Surgery for S. aureus." | `compare_wards` | Notes which wards are below n = 30 and shows counts instead |
| "How do we compare with Finland for E. coli blood 3GC resistance?" | `get_rate` (blood, 52 weeks), `get_benchmark` | Local annual rate with CI vs THL and ECDC, with the invasive-isolates caveat |

---

## 10. Build plan

### 10.1 Scope

| MVP (must demo) | Stretch |
|---|---|
| Seed + weekly replay with cursor, cleaning rules R1–R8 | Reporting lag simulation |
| `agg.rates` with first-isolate, Wilson CI, 30-gate | Demographic splits table |
| Anomaly engine: rate + count + sentinel, explanations, ranking, episodes | Drift / CUSUM signal |
| Ground-truth test passing in CI | Threshold tuning UI |
| Dashboard A (tiles, trend, ward antibiogram), B (inbox + detail), C (heatmap + ward forest plot) | C historical explorer with benchmark overlays, specimen small multiples |
| RSS feed: `alerts.xml` + `alerts-high.xml` + per-ward, deep links | Per-phenotype feeds, resolve items |
| GitHub Actions: ci, replay (dispatch + cron), migrate | Benchmarks job fully automated for all three sources |
| Benchmark: at least THL or ECDC loaded (CSV fallback is fine) | GLASS |
| Data quality page (basic) | AI assistant with grounding check |

### 10.2 Team split (4 people; merge roles for 3)

| Role | Owns | First deliverable |
|---|---|---|
| **Data engineer** | Supabase project, migrations, seed, replay, cleaning, `migrate.yml`, `replay.yml` | Staging loaded and `replay --advance 1` working |
| **Analytics engineer** | `aggregate.py`, `stats.py`, `detect.py`, ground-truth tests, `api` views shape | `agg.rates` reproducing 8.4% CIP baseline |
| **Frontend engineer** | Next.js app, sections A/B/C, quality page, deep-link URL scheme | Overview page reading a mock JSON of `api.current_vs_baseline` |
| **Integration + pitch** | Benchmarks job, `feed.py`, assistant (stretch), demo script, slides | Feed rendered from a hand-written alert JSON |

Parallelism comes from **agreeing the `api` view columns and the alert evidence JSON in the first
hour**. Once those two contracts exist, frontend builds against mock JSON, analytics fills the real
tables, and the feed is built from the same evidence shape.

### 10.3 Milestones (48-hour event; compress proportionally)

| Time | Milestone |
|---|---|
| H0–2 | Repo, Supabase project, Vercel project, secrets. Agree `api` view columns and evidence JSON. Benchmark routes checked. |
| H2–8 | Seed + replay + cleaning live in Supabase. Aggregation reproduces profile baselines. Frontend skeleton with filters and URL state on mock data. |
| H8–14 | `agg.rates` populated for weeks 56–156; `api` views; overview tiles and trend chart on real data. `replay.yml` running via dispatch. |
| H14–22 | Anomaly engine with episodes; ground-truth test green in CI. Alerts inbox + detail page. |
| H22–28 | RSS feeds generated and uploaded each run; deep links work. Heatmap and ward forest plot. |
| H28–34 | Benchmarks loaded and overlaid. Data quality page. Polish empty and n < 30 states. |
| H34–40 | Stretch: assistant with tools and grounding check; drift signal. |
| H40–44 | **Feature freeze.** Rehearse the demo against a reset cursor three times. Record a backup video. |
| H44–48 | Slides, methods page, submission. |

### 10.4 Key risks

| Risk | Mitigation |
|---|---|
| Benchmark sources lack a clean download | Committed CSV + parser fallback; benchmarks are context, not on the critical path |
| Too many alerts (noise) | BH correction, minimum effect size, 30-gate, episode grouping; measure false alarms in the ground-truth run |
| Slow window de-duplication | Precompute in Python per replay step (pandas over ~170k rows takes seconds); index `agg.rates` on its primary key |
| GitHub cron delay during demo | Demo uses `workflow_dispatch` or local CLI; cron only proves it runs unattended |
| Supabase anon key exposing patient rows | Only `api` exposed; RLS on everything; `api` views carry no identifiers; check with a curl using the anon key |
| Assistant hallucinating numbers | Fixed tools, grounding check, assistant is stretch and can be cut |
| Comparing urine rates to invasive EARS-Net data | Mapping table restricts each benchmark to the right specimen scope; caveat in UI |
| Demo data not "live" | Visible replay banner, a real Actions run during the demo, a feed item appearing in a reader |

### 10.5 Demo script (5 minutes)

1. **The problem (30 s).** "Tyks gets resistance numbers once a year, hospital-wide. A urologist in
   June 2025 has no idea what is happening on their ward this month."
2. **Overview (60 s).** Replay banner reads *Data through 2025-W20*. Show E. coli urine tiles: 4-week
   vs 52-week with n and CI. Switch the ward filter to ICU: percentages give way to "n = 8, too few"
   with counts. Point at the benchmark line from THL. This proves trustworthy numbers.
3. **Make time pass (60 s).** Click *Run workflow* on `replay.yml` with `advance = 5` (or run the CLI).
   The banner moves to 2025-W25. A **High** alert appears in the inbox, and at the same moment a new
   item lands in the RSS reader on screen: *"[HIGH] Urology · E. coli urine · ESBL share 34%
   (was 4%)"*.
4. **Investigate (60 s).** Click the feed item. It deep-links to the alert detail: why it fired,
   distinct patients, hospital-onset majority, co-resistance to ciprofloxacin and trimethoprim, and the
   ward breakdown showing it is Urology, not hospital-wide. Note that the hospital-wide ciprofloxacin
   rate moved too, which is exactly the signal an annual report would blur.
5. **Second outbreak (45 s).** Reset cursor to 2026-W09 and advance 3 weeks. ICU MRSA count alert fires:
   "13 MRSA in 4 weeks against a baseline of about 1.4% of ICU S. aureus". Show that the engine used counts, not a percentage, because
   ICU volumes are small.
6. **Noise vs signal (30 s).** Show a Low-ranked small blip and the transparency panel: the same
   engine that caught both outbreaks ranks small-sample noise low.
7. **(Stretch) Assistant (30 s).** Ask "Which combinations have shown unusual increases this month?"
   and click an evidence link.
8. **Close (15 s).** "Continuous, local, trustworthy, and it tells you when something changes."

Rehearse from a clean reset: `replay.yml` with `reset_to = 85`.

---

## Appendix: reference numbers from the profile

| Item | Value |
|---|---|
| Patients / cultures / isolates / AST results | 10,000 / 46,792 / 24,571 / 172,381 |
| Span | 2023-W40 to 2026-W39, 156 weeks |
| Isolates per week (all) | median 156 |
| E. coli urine first isolates per week | median 68 (39–98) |
| Urinary E. coli first-isolate %R (3 yrs) | CIP 8.4, TMP 18.4, NIT 0.4, MEC 2.7, CRO 3.9 |
| Blood E. coli 3GC (CRO) %R | 7.6 |
| ESBL share of E. coli / MRSA share of S. aureus | 3.6% / 3.8% |
| VRE / CPE (3 yrs) | 5 / 12 isolates |
| De-dup effect on E. coli urine denominator | −28% |
| Inpatient isolates sampled day 3+ | 71% |

Baselines were sanity-checked against Finres 2023 from memory only; load the THL source into the
benchmark layer before quoting national comparisons on a slide.

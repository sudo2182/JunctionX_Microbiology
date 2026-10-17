# AMR Watch

A continuously updated, laboratory-based antimicrobial resistance surveillance tool
(JunctionX Turku, Tyks x Mylab case). The full design is in [`BUILD_PLAN.md`](BUILD_PLAN.md);
this README covers how the repo is laid out and how to run it.

The lab data is the synthetic Finnish hospital export in `TYKS_data/` (156 ISO weeks,
2023-W40 to 2026-W39). A weekly **replay** releases it one week at a time so every view behaves
as if results were arriving live.

## Layout and module boundaries

```
supabase/migrations/   SQL: schemas, tables, api views, RLS, grants           (foundation)
supabase/local_roles.sql  anon/authenticated/service_role stand-ins for vanilla Postgres (tests only)
pipeline/              Python package, run as `python -m pipeline.<module>`
  weeks.py             week_idx <-> ISO week (1 = 2023-W40, 156 = 2026-W39)   (foundation)
  reference.py         default reference sets, mirrored from ref.* seed rows  (foundation)
  clean.py             rules R1-R8, pure pandas                               (foundation)
  stats.py             wilson(), exact binomial / Poisson tails, BH           (foundation)
  aggregate.py         first-isolate window rates + Wilson CI -> agg.rates    (foundation)
  seed.py              CSVs -> staging.*                                      (foundation)
  replay.py            staging -> lab, one ISO week at a time, cursor         (foundation)
  run.py               orchestrates one run: advance -> aggregate -> detect -> feed -> log
  db.py                psycopg helpers (COPY, upsert, load frames)
  detect.py            anomaly engine -> agg.alert_episodes / alert_firings   (anomaly-engine build)
  feeds/               RSS feeds -> Storage bucket `feeds`, agg.feed_log      (RSS build)
  announcements/       ECDC RSS monitor -> bench.announcements, api.announcements
  benchmarks/          THL external data -> bench.observations         (data-importer build)
tests/                 pytest; data/fixtures/ holds tiny hand-built CSVs
web/                   Next.js dashboard, reads api.* only                    (dashboard build)
.github/workflows/     ci.yml, replay.yml, migrate.yml
```

Contracts between the builds:

| Boundary | Contract |
|---|---|
| `run.py` -> `detect.py` | `detect.run(conn, weeks, run_id, ref) -> dict`, called with every week_idx just released, after `agg.rates` is written for them. Must be idempotent per week. Thresholds in `ref.alert_rules`. |
| `run.py` -> `feeds` | `pipeline.feeds.publish.run(conn=conn, upload=...)`, the last step of every run. Skipped automatically until `pipeline/feeds/` is merged. |
| pipeline -> dashboard | The `api.*` views only (columns in `supabase/migrations/*_api_views.sql`). No patient ids, birth years or exact dates; the smallest time unit is the ISO week. |
| external data | `bench.observations` holds THL figures with provenance. It is never joined to `lab.*` or `agg.*`; `ref.benchmark_comparability` is the only link, and the dashboard reads `api.benchmarks`, `api.benchmarks_by_sex`, `api.external_context` and `api.external_sources`. See "External benchmarks" below. |
| `agg.rates` | One row per `(end_week_idx, window_weeks, organism, antibiotic_code, specimen, scope_type, scope_value)`. `antibiotic_code` is a WHONET code or a phenotype marker `ESBL`/`MRSA`/`VRE`/`CPE`. `specimen = 'all'` and `window_weeks = 1` exist at hospital scope only. `reportable` = `n_tested >= 30`. Intrinsic and non-reportable AST rows never count. |

Change the schema with a **new** migration file (`supabase/migrations/<timestamp>_<name>.sql`); never
edit one that has been applied. Keep every migration safe to re-apply (`if not exists`, `on conflict do
nothing`, drop-and-recreate for views): `migrate.yml` re-applies them when the schema was created outside
this repo, e.g. through the Supabase dashboard.

## Cleaning rules (BUILD_PLAN.md §3.2)

| Rule | Where | What |
|---|---|---|
| R1 intrinsic resistance | `clean.flag_intrinsic`, `ref.intrinsic_resistance` | K. pneumoniae/K. oxytoca/C. freundii-AMP, P. mirabilis-NIT kept but `is_intrinsic`, excluded from every rate (5,137 rows in the dataset) |
| R2 urine-only agents | `clean.flag_reportable` | MEC, TMP, NIT on a non-urine specimen -> `reportable = false` |
| R3 hospital onset | `clean.classify_onset` | inpatient sampled day 3+ of admission (admission day = day 1) -> `hospital`; day 1-2 -> `community`; outpatients -> `outpatient` |
| R4 first isolate | `aggregate.first_isolates` | per patient, species, specimen, **within each window and scope** |
| R5 setting | `clean.classify_setting` | `inpatient` / `ed` / `primary_care` |
| R6 codes | `clean.clean_batch` | unknown ward, organism or antibiotic code, or a result outside S/R -> `lab.rejects` (counted, never dropped silently) |
| R7 derived | `clean.age_band` | age band, sex |
| R8 validation | `clean.validate` | volume vs trailing median, isolates without AST, sample dates after the week; a `fail` stops the run before aggregation |
| 30-isolate gate | `aggregate.MIN_N` | `reportable = n_tested >= 30` |

The aggregation reproduces the data profile: hospital-wide first-isolate urinary E. coli over
three 52-week windows is n = 7,657 with ciprofloxacin 8.4% R and trimethoprim 18.4% R
(`tests/test_aggregate.py::test_regression_matches_data_profile`).

## Run locally

Needs Python 3.11+ and, for the database steps, Postgres 15+ (a local server or the Supabase
project).

```bash
pip install -r requirements-dev.txt
ruff check . && pytest -q                    # unit tests + full-dataset regression

# Optional: integration tests against a throwaway local Postgres (the test wipes it)
createdb amr_test
TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/amr_test pytest -q
```

Run the whole pipeline against a database where the migrations are applied:

```bash
export SUPABASE_DB_URL=postgresql://...      # local Postgres or the Supabase session pooler
python -m pipeline.run --seed --reset-to 85  # load staging, backfill to 2025-W20 (demo start)
python -m pipeline.run --advance 1           # release the next week
python -m pipeline.run --advance 5           # 2025-W25: the Urology ESBL outbreak is under way
```

To apply the migrations to a local Postgres:

```bash
psql "$SUPABASE_DB_URL" -f supabase/local_roles.sql   # local only, never on Supabase
for f in supabase/migrations/*.sql; do psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "$f"; done
```

A reset to week 85 aggregates every backfilled week (about 90 s locally, ~650k `agg.rates` rows);
each further week adds about 7,700 rows.

### The dataset

The CSVs are read from `AMR_DATA_DIR` if set, else `data/raw/` (git-ignored), else `TYKS_data/`
(already committed to this repo). Nothing else needs a copy of the full dataset; tests use the tiny
fixtures in `data/fixtures/` plus `TYKS_data/` for the regression test (skipped if absent). For the
hosted replay, `seed` runs inside the Action from the checked-out `TYKS_data/`, so no Storage upload
is needed.

## Supabase setup (project `jofgoferdnkihimvencr`)

Do these in order. The `api` schema only exists after step 2, and GitHub only lets you run
`migrate` and `replay` by hand once the workflows are on `main`.

1. **Create the GitHub environment `supabase-prod`** (repo Settings -> Environments) with these
   secrets:

   | Secret | Where to find it | Used by |
   |---|---|---|
   | `SUPABASE_DB_URL` | Project Settings -> Database -> Connection string -> **Session pooler** (with the DB password filled in; percent-encode any special characters in it) | `replay.yml`, `migrate.yml` |
   | `SUPABASE_URL` | `https://jofgoferdnkihimvencr.supabase.co` | feed upload |
   | `SUPABASE_SERVICE_ROLE_KEY` | Project Settings -> API keys -> service_role | feed upload |
   | `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` | optional; only for running the Supabase CLI from a laptop | none |

   Optional repository variables: `SUPABASE_PROJECT_REF` (defaults to `jofgoferdnkihimvencr`),
   `APP_BASE_URL`, and `REPLAY_CRON_ENABLED=true` to turn on the hourly replay.
2. **Apply the migrations** (this creates the `api` schema): merge this PR to `main`, which runs
   `migrate.yml` automatically, or run it later from the Actions tab. From a laptop instead:
   `supabase link --project-ref jofgoferdnkihimvencr && supabase db push`.
3. **Expose only `api`.** Project Settings -> API -> Exposed schemas: add `api` (keep `public`,
   `graphql_public`). Do not expose `staging`, `lab`, `ref`, `bench` or `agg`.
4. **First load**: Actions -> replay -> Run workflow with `reset_to = 85`. Tick `seed` only if
   `staging.*` is empty; re-seeding truncates and reloads the same CSVs, so it is safe but not needed
   once the data is in.
5. **Demo**: Run workflow with `advance = 1` (or 5). Rehearse from `reset_to = 85`.

The service role key never goes to Vercel or the browser; the dashboard uses the anon key, which
can only `select` from `api.*` (RLS is enabled on every other table with no policies).

## External benchmarks (THL)

Official national and European figures, kept **apart from the local TYKS data**. They are annual, aggregate and
cover different populations, so they are context, never mixed into `agg.rates`.

| Source | What it is | How it gets in | Reuse |
|---|---|---|---|
| THL infectious diseases register (`thl_nidr`) | Notified **cases and incidence per 100,000** for invasive (blood/CSF) MRSA, ESBL, VRE and for carriage, Finland and Southwest Finland, whole years | THL's open JSON-stat API, fetched by the importer (`--source thl_nidr`) | CC BY 4.0 |
| THL Finres report (`thl_finres`) | **% resistant and number tested**, national, 2015-2024, urine (by sex), blood, K. pneumoniae, P. aeruginosa, S. aureus, E. faecalis | Tables transcribed from the report PDF into `pipeline/benchmarks/data/finres_2024.csv` (`finres_extract.py`, reviewed); PDF not committed | CC BY-NC-ND 4.0, figures only, attribution shown |

Rules the importer enforces (`pipeline/benchmarks/`):

- Only **whole calendar years** are imported. Compare an external year only with local first isolates over the same calendar year.
- Nothing is invented: a cell the source does not publish (`*` in Finres, no value in THL) is skipped and counted, never stored as 0. No confidence intervals or resistant counts are derived from rounded percentages.
- THL register rows are counts and incidence, not "% resistant", and are only exposed through `api.external_context`.
- `ref.benchmark_comparability` (`pipeline/benchmarks/data/comparability.csv`) lists which external series may sit beside which local rate: same antimicrobial, same organism, blood with blood/CSF and urine with urine, same sex. Urine E. coli exists in Finres only per sex, so it is in `api.benchmarks_by_sex`, never in `api.benchmarks`. No VRE benchmark: THL pools enterococci, the local data is E. faecalis only.
- Every run is recorded in `bench.import_runs` (what was read, checksum, rows inserted/updated/unchanged/skipped, error). A bad batch writes nothing. Re-running identical input changes nothing.
- The local dataset is synthetic, so any comparison with these real figures is illustrative.

Commands (need `SUPABASE_DB_URL`, except `--dry-run`, which then only parses and validates):

```bash
python -m pipeline.benchmarks --source thl_nidr --dry-run        # fetch THL, validate, write nothing
python -m pipeline.benchmarks --source all                       # thl_nidr + finres
pytest tests/benchmarks -q
```

**Adding a new Finres report:** download the PDF, then
`python -m pipeline.benchmarks.finres_extract --pdf Finres2025.pdf --release 2025` (checks every table against its expected
rows, stops on anything unexpected). Compare the CSV with the report, set `"reviewed": true` in the `.meta.json`, commit both.
Table numbers and pages in `finres_extract.TABLES` must be checked against the new edition first.

The dashboard must show `attribution` and the `caveat` text from `api.benchmarks` / `api.external_sources` next to any
external line, and the retrieval date.

## ECDC RSS Announcements Monitor (`pipeline/announcements/`)

Checks official ECDC RSS feeds for AMR-related announcements (surveillance reports, publications, threat reports,
epidemiological updates, risk assessments, news). It is a **discovery tool**: it stores titles, links, dates and the
feed's short summary, and sorts each item with transparent keyword rules (`filter.py`) into `relevant`, `review` or
`unrelated`. A keyword match is not an outbreak or a confirmed clinical alert, and no rates are derived from it.

- Storage: `bench.announcements`, one row per item, keyed on the feed GUID (canonical article URL when there is
  none), so re-runs never duplicate. Every check is logged in `bench.import_runs` (`source_id = 'ecdc_rss'`).
- Dashboard: `api.announcements` (sort it yourself, e.g. `order=published_at.desc.nullslast`) and the last successful
  check in `api.external_sources.last_import_at`.
- Schedule: **not real time.** The `ecdc_announcements.yml` workflow runs on demand, and daily at 06:23 UTC once the
  repository variable `ANNOUNCEMENTS_CRON_ENABLED` is `true`. Each ECDC feed lists only its latest ~10 items, so
  checking less than daily can miss items.
- One failing feed (network error, HTTP error, HTML or empty response) is reported and skipped; the run fails only
  when every feed fails.

Feeds (all listed on <https://www.ecdc.europa.eu/en/rss-feeds>; configured in `config.py`):
`surveillance` (1253), `publications` (1244), `threats_cdtr` (1505), `aer` (1502), `risk_assessments` (1295),
`news` (1307), `epi_updates` (1310).

```bash
python -m pipeline.announcements --dry-run                 # fetch & classify live feeds, write nothing
python -m pipeline.announcements --dry-run --only-relevant # same, show only relevant/review items
python -m pipeline.announcements --db                      # store in bench.announcements (needs SUPABASE_DB_URL)
python -m pipeline.announcements --dry-run --json          # structured report
pytest tests/announcements                                 # unit tests; DB tests need TEST_DATABASE_URL
```

ECDC content is CC BY 4.0 unless stated otherwise: show `attribution` from `api.announcements` next to the items.

## Workflows

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | pull request, push to `main` | `ruff`, `pytest` (incl. migrations + replay against a Postgres service), `gitleaks` |
| `replay.yml` | `workflow_dispatch` (+ hourly cron when enabled) | `python -m pipeline.run --advance N [--reset-to K] [--seed]` |
| `benchmarks.yml` | `workflow_dispatch` (+ monthly cron when `BENCHMARKS_CRON_ENABLED=true`) | `python -m pipeline.benchmarks --source <all\|thl_nidr\|finres> [--dry-run]` into `bench.observations` |
| `ecdc_announcements.yml` | `workflow_dispatch` (+ daily cron when `ANNOUNCEMENTS_CRON_ENABLED=true`) | `python -m pipeline.announcements --db [--dry-run] [--only-relevant]` into `bench.announcements` |
| `migrate.yml` | push to `main` touching `supabase/migrations/**`, or manual | `supabase db push --db-url $SUPABASE_DB_URL` (no access token needed) |

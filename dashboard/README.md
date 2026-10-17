# AMR Watch dashboard

Next.js (App Router, TypeScript) + Tailwind + Apache ECharts. It reads only the read-only Supabase `api`
views described in `BUILD_PLAN.md` §4.3, and falls back to local mock data shaped exactly like those views
when no Supabase keys are set.

| Page | Plan section | What it shows |
|---|---|---|
| `/` Overview | A | KPI tiles (4 weeks vs the previous 52, n, 95% CI, arrow coloured only when CIs separate), trend with Wilson band and volume panel, ward antibiogram (%S, toggle to %R), top open alerts |
| `/alerts` | B | Alert inbox ranked by severity × confidence, sparklines, filters, acknowledge/dismiss, engine rules and planted-outbreak validation |
| `/alerts/[id]` | B | Why it fired, ward/specimen/onset breakdown, co-resistance, distinct patients, trend with the firing weeks shaded, firing history, "Explore in C" |
| `/explore` | C | Organism × antibiotic heatmap (click to drill down), ward forest plot, specimen small multiples, year by year, setting/onset splits |
| `/quality` | Data steward | Rows released per run, exclusions, validation checks, first-isolate de-duplication |
| `/feed/[name].xml` | RSS | Redirects to `{SUPABASE_URL}/storage/v1/object/public/feeds/{name}.xml` |

**Honest numbers.** Every percentage carries n and its CI. Below 30 first isolates the value is replaced by
"n = 17, too few for a %" and counts. Urine-only agents (MEC, TMP, NIT) leave the antibiotic picker for blood
and wound. Intrinsic pairs show as "IR" and are never in a rate.

## Run it

```bash
cd dashboard
npm install
npm run dev          # http://localhost:3000, on mock data
```

`npm run build && npm start` for a production build; `npm run lint` and `npx tsc --noEmit` for checks.

### Connect Supabase

```bash
cp .env.example .env.local
# NEXT_PUBLIC_SUPABASE_URL=https://jofgoferdnkihimvencr.supabase.co
# NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key from Settings → API>
```

The `api` schema must be listed under *Settings → API → Exposed schemas*. Only the anon key is used; never put
the service role key in this app. `DATA_SOURCE=mock` forces the mock even when keys are set. On Vercel, set the
project root to `dashboard/` and add the same two variables.

## URL scheme (deep links)

All filters live in the query string, so RSS items, alerts and shared links open an exact view.

| Param | Values | Default |
|---|---|---|
| `ward` / `setting` / `onset` | ward code (`URO`), `inpatient`·`ed`·`primary_care`, `hospital`·`community`·`outpatient` | whole hospital |
| `specimen` | `urine`, `blood`, `wound` | `urine` |
| `organism` | slug of the Latin name, e.g. `escherichia-coli` (same slug as the feeds) | E. coli |
| `abx` | WHONET code or phenotype: `CIP`, `ESBL`, `MRSA`… | `CIP` |
| `window` | `4`, `13`, `52` | `4` |
| `measure` | `r` or `s` (on the overview, toggles the antibiogram) | |

Alerts: `/alerts?severity=high&ward=URO&marker=ESBL&organism=escherichia-coli&type=rate&status=all`;
`severity` is a minimum. Detail: `/alerts/{alert_id}?week=2025-W25` (the link the RSS feed writes), where
`alert_id` looks like `A-2025W24-URO-ECOLI-URINE-ESBL`. The detail route also accepts an `episode_id`.

## Data contract

`src/lib/data/types.ts` holds one TypeScript row type per `api` view; both sources return exactly these
shapes, so switching to Supabase needs no UI change. The views the Supabase source queries:

| View | Used by | Filtered on |
|---|---|---|
| `api.replay_status` | banner | single row |
| `api.current_vs_baseline` | KPI tiles | scope, organism, antibiotic_code |
| `api.rate_series` | trends, sparklines, splits | organism, antibiotic_code, specimen, scope, window_weeks |
| `api.antibiogram` | overview table | specimen, scope |
| `api.heatmap` | explore | specimen, scope, window_weeks |
| `api.ward_comparison` | forest plot | organism, antibiotic_code, specimen, window_weeks |
| `api.alerts`, `api.alert_detail` | B | `alert_id` or `episode_id` |
| `api.benchmarks` | dotted benchmark line | organism, antibiotic_code |
| `api.data_quality` | quality page | latest `week_idx` first |
| `api.ref_antibiotics`, `ref_wards`, `ref_organisms`, `ref_intrinsic_resistance`, `ref_weeks` | pickers, labels | — |

Scope is `(scope_type, scope_value)`: `('hospital','ALL')`, `('ward','URO')`, `('setting','ed')`,
`('onset','hospital')`. Phenotype shares use `antibiotic_code` = `ESBL`/`MRSA`/`VRE`/`CPE`, and specimen
`all` is allowed for them. Alert evidence follows the §7.4 JSON. If the pipeline's view columns differ, change
`types.ts` and `supabase.ts` only.

## Mock data

`src/mock/` is generated from `TYKS_data/*.csv` by `scripts/build_mock.py` (pandas; about 2 minutes):

```bash
python3 dashboard/scripts/build_mock.py   # from the repo root
```

It applies the cleaning rules (intrinsic R excluded, urine-only agents, onset, setting), de-duplicates first
isolates within every 1/4/13/52-week window, and runs a **simplified** copy of the §7 anomaly engine so the
alert pages have realistic content. Both planted outbreaks fire (Urology ESBL from 2025-W23, ICU MRSA from
2026-W11). The real engine is `pipeline/detect.py`; the mock is only a stand-in and is noisier.

`MOCK_CURSOR_WEEK` sets the replay week the mock pretends to be at (default 91 = 2025-W26; try 130 for the ICU
cluster). No benchmark data is mocked: the national line appears once THL/ECDC rates are loaded.

## Not done yet

- Alert acknowledge/dismiss is stored in the viewer's browser, because the `api` views are read-only.
- Multi-select wards, custom date ranges, sex/age splits (`agg.rates_demo`), and the AI assistant (D).
- Realtime pulse on a new week: the banner updates on page load.

# Benchmark sources

Annual, aggregate rates used as context lines next to our local data (BUILD_PLAN 3.3).
None of these routes could be reached from the build container (no outbound access to
ecdc.europa.eu, thl.fi or who.int), so each route below still needs one manual check by the
benchmark owner. Record the exact URL or export steps here once confirmed.

Each refresh reads `raw/<source>_*.csv` (committed exports, later file names win) and,
if the Actions variable `BENCH_<SOURCE>_URL` is set, a direct download that takes
precedence. A failed download falls back to the committed files with a warning in the run
summary. A file that fails validation stops the whole run before anything is written.

| Source | File name | Parser | Specimen scope | Status |
|---|---|---|---|---|
| ECDC Surveillance Atlas (EARS-Net) | `raw/ecdc_atlas_<YYYY-MM-DD>.csv` | `ecdc.py` | invasive | to confirm |
| THL Finres tables | `raw/thl_finres_<year>.csv` | `thl.py` (tidy CSV) | urine / invasive / all | to confirm |
| WHO GLASS | `raw/glass_<YYYY-MM-DD>.csv` | `glass.py` (tidy CSV, GLASS aliases) | invasive / urine | to confirm |

## ECDC Surveillance Atlas of Infectious Diseases

1. Open https://atlas.ecdc.europa.eu/public/index.aspx, choose *Antimicrobial resistance*.
2. For each population (`Escherichia coli|Third-generation cephalosporins`,
   `…|Fluoroquinolones`, `…|Aminopenicillins`, `…|Carbapenems`,
   `Klebsiella pneumoniae|…`, `Pseudomonas aeruginosa|Piperacillin + tazobactam`,
   `…|Ceftazidime`, `…|Carbapenems`, `Staphylococcus aureus|Meticillin (MRSA)`), select the
   indicators *R - resistant isolates, percentage* and *Total tested isolates*, regions
   Finland and EU/EEA, all years.
3. Export as CSV and save unchanged as `raw/ecdc_atlas_<date>.csv`.

Expected columns: `HealthTopic, Population, Indicator, Unit, Time, RegionCode, RegionName,
NumValue, TxtValue`. If the real export differs, adjust `ecdc.py` and its fixture together.

Caveats for the UI: EARS-Net covers invasive isolates (blood / CSF) only, so compare with our
blood rates, never urine. EARS-Net VRE is *E. faecium*; we only have *E. faecalis*, so no VRE line.

## THL (Finres)

THL's open data cubes on sampo.thl.fi (`/pivot/prod/en/ttr`) hold notified case counts
(MRSA, ESBL, CPE, VRE), not %R, so the %R route is the annual Finres report tables,
transcribed once per year into the tidy format:

```
country,year,organism,antimicrobial_group,specimen_scope,n_tested,pct_r,source_url
FI,2023,Escherichia coli,fluoroquinolones,urine,<n>,<pct>,<report URL>
```

`n_resistant` may replace `pct_r`. Groups are normalised (`ciprofloxacin` and
`Fluoroquinolones` both become `fluoroquinolones`). Best comparator for our urine rates:
same country, same EUCAST breakpoints.

## WHO GLASS

Use the dashboard's own data download or the GLASS report annex. Do not scrape the Shiny app:
its URL carries session tokens and changes. Save as `raw/glass_<date>.csv`. Common GLASS
column names (`Iso3`, `Year`, `PathogenName`, `AbTargets`, `Specimen`, `InterpretableAST`,
`Resistant`) are mapped automatically; anything else can be renamed to the tidy columns.
Label as "global context": different case definitions and coverage.

## Mapping to our data

`mapping.csv` maps our organism + WHONET code (or phenotype) + specimen to a benchmark
`antimicrobial_group` and `specimen_scope`. A combination without a row gets no benchmark
line rather than a misleading one. Urine rows only ever map to `urine` benchmarks.

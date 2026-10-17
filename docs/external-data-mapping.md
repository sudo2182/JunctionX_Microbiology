# External data → dashboard mapping plan (THL Finres, THL infectious diseases register)

How the external rows already in Supabase map onto the structures the Lovable dashboard (`Kasper/…/src/lib/amr/`)
already uses, so they can be added later without new tables or ad hoc column names.

Status: **plan only, nothing in the dashboard reads these yet.** All facts below were checked against the live
project `jofgoferdnkihimvencr` on 2026-10-17.

## 1. What exists today

| Source | Rows | What it is | Years | Geography | Browser-readable view |
|---|---|---|---|---|---|
| THL **Finres** 2024 report (`thl_finres`) | 585 | % resistant among tested **first isolates**, with `n` tested (no numerator published) | 2015–2024 | Finland only | `api.benchmarks` (sex = all), `api.benchmarks_by_sex` (E. coli urine, female/male) |
| THL **infectious diseases register** (`thl_nidr`) | 528 | Notified **case counts** and **incidence per 100 000 population** | 2015–2025 | Finland + Southwest Finland wellbeing services county (`wsc:05`, where Tyks is) | `api.external_context` |
| Source metadata | 3 | Licence, attribution text, last successful import | – | – | `api.external_sources` |

All four views answer the publishable key today (`supabase.schema("api").from(…)`): verified with REST calls.
`ref.benchmark_comparability` (44 rows, from `pipeline/benchmarks/data/comparability.csv`) decides which Finres
series may sit next to which local rate; `api.benchmarks*` only return those pairs. **No row, no comparison.**

## 2. The dashboard's vocabulary (the target)

| Concept | Dashboard form | Defined in |
|---|---|---|
| Organism | Latin name, e.g. `Escherichia coli` | `ORGANISMS` ← `api.ref_organisms` |
| Antibiotic | WHONET code, e.g. `CRO` | `ANTIBIOTICS` ← `api.ref_antibiotics` |
| Phenotype marker | `esbl` / `mrsa` / `vre` / `cpe` (bits 1/2/4/8 in `flags`) | `MARKERS` |
| Specimen | `urine` / `blood` / `wound` | `SPECIMENS` |
| Sex | `F` / `M` | `IsolateRecord.sex` |
| Time | ISO date; week index from Monday 2023-10-02 | `weekIndex()` |
| Rate | `{ n, r, pct, reportable }`, `reportable = n >= 30` | `resistance()` in `stats.ts` |
| De-duplication | first isolate per patient + organism + specimen **within the window** | `firstIsolates()` |
| Feed item | `Alert { title, summary, url, region, organism, severity, date, source }` | `store.ts` |

## 3. Finres → `ExternalRate`

Proposed type, shaped like `resistance()` so the same chart and table code can draw it:

```ts
export type ExternalRate = {
  organism: string;          // api.benchmarks.organism (already the dashboard's Latin name)
  code: string;              // antibiotic_code: WHONET code, or "ESBL" / "MRSA"
  marker?: "esbl" | "mrsa";  // set when code is a phenotype; matches MARKERS[].key
  specimen: "blood" | "urine";
  sex: "all" | "F" | "M";
  year: number;              // calendar year
  n: number | null;          // n_tested
  r: null;                   // Finres publishes no numerator; never back-calculate one as if published
  pct: number;               // pct_r
  reportable: boolean;       // n === null || n >= 30
  geo: "Finland";
  source: string; sourceUrl: string; retrievedAt: string; caveat: string; attribution: string;
};
```

| `bench.observations` / `api.benchmarks` column | → `ExternalRate` | Rule |
|---|---|---|
| `organism` | `organism` | Identical strings. All 5 Finres organisms exist in `ref.organisms`. |
| `antibiotic_code` (from comparability) | `code` | Finres codes are already WHONET. 11 overlap the local panel (AMP MEC TZP CXM CRO CAZ MEM CIP TMP NIT CLI). ERY, LVX, RIF, SXT, TCY, TOB, LEX have **no local equivalent**, so they're not overlaid (a national-only table at most). |
| `phenotype` `ESBL` / `MRSA` | `code` + `marker` = `esbl` / `mrsa` | Compare with `flags & MARKERS[k].bit` share among first isolates. The caveat says local flag definitions may differ. |
| `ext_specimen` `blood_csf` → `specimen` `blood` | `specimen` | `urine` → `urine`. Finres `pus` (E. faecalis AMP only) has **no** comparability row; local `wound` ≠ pus, so not shown. |
| `sex` `all` / `female` / `male` | `all` / `F` / `M` | E. coli urine exists **only** by sex in Finres: compare with the local rate for the same sex. |
| `year` (`period_start`) | `year` | Calendar year. |
| `n_tested` (`denominator`) | `n` | |
| `pct_r` (`value`) | `pct` | Already 0–100. |
| `ci_low` / `ci_high` | – | Null for Finres. A Wilson CI from `pct` and `n` would be *derived*; label it so if ever shown. |
| `source`, `source_url`, `retrieved_at`, `caveat`, `attribution`, `licence` | provenance fields | Show `attribution` wherever the value is shown (licence condition). |

**Local comparator for the same cell** (must match Finres's method, or the comparison is misleading):

```ts
const yearRecords = records.filter((r) => r.date.startsWith(String(year)) && r.organism === org && r.specimen === specimen && (sex === "all" || r.sex === sex));
const local = resistance(firstIsolates(yearRecords), code);   // or marker share via flags
```

`firstIsolates()` over one calendar year is the same rule as Finres (first isolate per patient, species and specimen
type per year). Local data runs 2023-10-02 → 2026-04-12, so **2024 is the only full year that overlaps Finres
2024**. 2023 and 2026 are partial and must not be compared.

Worked example (computed in SQL on 2026-10-17): *E. coli*, blood, ceftriaxone, 2024: local **5.4 % (5/93)** vs
Finres national **7.0 % (n = 4 131)**. Local *K. pneumoniae* blood meropenem 2024: 0/41.

## 4. Infectious diseases register → `ExternalCount`

```ts
export type ExternalCount = {
  organism: string;                     // Latin name; may be outside ORGANISMS (see below)
  marker: "esbl" | "mrsa" | "vre" | "cpe" | "not_mrsa";
  specimen: "blood" | "carriage";
  area: "Finland" | "Southwest Finland";
  year: number;
  cases: number;                        // indicator = 'cases'
  per100k: number | null;               // indicator = 'incidence_per_100k' (numerator = cases, denominator = population)
  source: string; sourceUrl: string; retrievedAt: string; attribution: string;
};
```

| `api.external_context` column | → `ExternalCount` | Rule |
|---|---|---|
| `organism` | `organism` | *E. coli*, *K. pneumoniae*, *S. aureus* match. **`Enterococcus spp.`** (VRE) and **`Enterobacter cloacae`** (CPE) are not in the local list: show them as regional context only, never matched to *E. faecalis*. |
| `phenotype` | `marker` (lower-case) | `not_MRSA` exists only so MRSA's share of *S. aureus* bacteraemia notifications can be derived: MRSA / (MRSA + not_MRSA). Label it **derived**. |
| `specimen` `blood_csf` → `blood`; `carriage` → `carriage` | `specimen` | Local data has **no screening specimens**, so carriage counts have no local counterpart. |
| `geo_code` `FI` → `Finland`; `wsc:05` → `Southwest Finland` | `area` | |
| `year` | `year` | 2025 is the latest complete year. |
| `indicator` + `value` | `cases` or `per100k` | Pivot the two indicator rows into one object per key. |

**What it can and cannot be compared with.** These are notifications per population, not shares of tested
isolates. The dashboard has no catchment population, so it **cannot** compute a local incidence. Allowed:
regional trend cards (Southwest Finland vs Finland per 100 000), and an *unscaled* side-by-side of the local count of
marker-positive blood **patients** per calendar year (first isolate per patient per marker). Never a ratio
between the two.

## 5. Where it fits in the current pages

| Page | Fit | Why not a direct overlay |
|---|---|---|
| `/wards` trend (% resistant by ward) | **New panel** "National comparison (Finres)": organism + antibiotic + specimen (+ sex for E. coli urine), yearly bars local vs national | The ward chart pools every specimen; Finres is specimen-specific. An overlay would compare different populations. |
| Marker charts (ESBL/MRSA/…) | Same panel, `code = ESBL/MRSA` rows | Marker charts pool all species; Finres ESBL is per species and specimen. |
| `/` overview | Card "Regional notifications" from `ExternalCount` (Southwest Finland vs Finland, last 5 years) | Counts, not rates. |
| Records / detection / risk | None | Individual-level tools; national aggregates add nothing there. |

Loader sketch for `store.ts` (same pattern as `loadReference`; ~1.2k rows in total, so one request each):

```ts
const api = supabase.schema("api");
const [all, bySex, ctx, sources] = await Promise.all([
  api.from("benchmarks").select("organism, antibiotic_code, specimen, year, n_tested, pct_r, source, source_url, retrieved_at, caveat, attribution"),
  api.from("benchmarks_by_sex").select("organism, antibiotic_code, specimen, sex, year, n_tested, pct_r, source, source_url, retrieved_at, caveat, attribution"),
  api.from("external_context").select("organism, phenotype, specimen, geo_code, year, indicator, value, source, source_url, retrieved_at, attribution"),
  api.from("external_sources").select("source_id, name, attribution, licence, last_import_at"),
]);
```

The `api` block in `src/integrations/supabase/types.ts` has to gain these four views (same way as `ref_*`).

## 6. Guardrails (apply to every external value shown)

1. Only pairs present in `api.benchmarks` / `api.benchmarks_by_sex` are compared. Everything else is context.
2. Same calendar year, same specimen, same sex series; local side uses `firstIsolates()` over that year.
3. Show `n` on both sides and the `caveat`; local `n < 30` shows "n = …" instead of a percentage, as today.
4. Label: "National (THL Finres 2024 report)" / "Local (synthetic TYKS data)". Never present the gap as a
   clinical finding; the local data is synthetic.
5. Show `attribution` and the last import time from `api.external_sources`.
6. Values derived by us (MRSA share from notifications, any CI for Finres) are marked *derived*.

## 7. Open points

- Finres 2025 isn't published yet; when it is, re-run the Finres importer and 2025 becomes a second comparable year.
- The live Lovable project has PAN/MDR derived markers (`flags` bits 16/32, `public.amr_*` functions) that this
  Kasper copy doesn't read. Neither external source reports those, so they need no mapping.

-- AMR Watch: external surveillance observations (ECDC EARS-Net, THL Finres, THL infectious diseases register).
--
-- External data is kept apart from the local TYKS lab data: nothing in `lab` or `agg` references these
-- tables, and the only link is ref.benchmark_comparability, which says which external series may be shown
-- next to which local rate. bench.rates (the earlier, narrower benchmark table) is left in place, unused.

create table if not exists bench.sources (
  source_id      text primary key,        -- 'ecdc_ears_net' | 'thl_finres' | 'thl_nidr'
  name           text not null,
  publisher      text not null,
  landing_url    text not null,
  access_method  text not null check (access_method in ('api', 'manual_export', 'report_table')),
  licence        text not null,
  attribution    text not null,           -- statement the dashboard must show next to the data
  methodology    text,                    -- what is known about case definition, breakpoints, coverage
  update_cadence text                     -- as stated by the publisher
);

insert into bench.sources (source_id, name, publisher, landing_url, access_method, licence, attribution, methodology, update_cadence) values
  ('ecdc_ears_net',
   'EARS-Net (ECDC Surveillance Atlas of Infectious Diseases)',
   'European Centre for Disease Prevention and Control (ECDC)',
   'https://atlas.ecdc.europa.eu/public/index.aspx?Dataset=27&HealthTopic=4',
   'manual_export',
   'ECDC data reuse: credit the source; do not redistribute the raw export without ECDC consent (Atlas data disclaimer)',
   'Dataset provided by ECDC based on data provided by public health authorities, scientific institutes or healthcare providers in the reporting countries and WHO. Adapted by AMR Watch.',
   'Invasive isolates only (blood and cerebrospinal fluid), annual, by country and EU/EEA. Antimicrobials are reported per group.',
   'Annually, mid-November'),
  ('thl_finres',
   'Finres: Antimicrobial resistance of bacteria in Finland',
   'Finnish Institute for Health and Welfare (THL)',
   'https://urn.fi/URN:ISBN:978-952-408-596-0',
   'report_table',
   'CC BY-NC-ND 4.0 (report). Only published figures are extracted; the report itself is not redistributed.',
   'Source: THL, Finres report (Bakteerien mikrobilääkeresistenssi Suomessa). Figures transcribed by AMR Watch.',
   'First isolate per patient, species and specimen type per year; EUCAST breakpoints; resistant share only calculated where more than half of the isolates were tested.',
   'Annually'),
  ('thl_nidr',
   'THL National Infectious Diseases Register, statistical database (cases)',
   'Finnish Institute for Health and Welfare (THL)',
   'https://sampo.thl.fi/pivot/prod/en/ttr/cases/fact_ttr_cases.json',
   'api',
   'CC BY 4.0 (THL open data)',
   'Source: THL, National Infectious Diseases Register. Retrieved and adapted by AMR Watch.',
   'Notified case counts and incidence per 100,000 population. These are counts, not the share of tested isolates that are resistant.',
   'Continuously updated by THL')
on conflict (source_id) do nothing;

-- One row per importer run: what was read, from where, what changed. Written even when the run fails.
create table if not exists bench.import_runs (
  run_id         bigint generated always as identity primary key,
  source_id      text not null references bench.sources (source_id),
  dataset        text not null,
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  source_url     text,
  input_name     text,                     -- file name for manual / committed inputs
  input_sha256   text,                     -- checksum of the exact bytes imported
  retrieved_at   timestamptz,
  rows_parsed    int,
  rows_inserted  int,
  rows_updated   int,
  rows_unchanged int,
  rows_skipped   int,                      -- source cells with no published value, or out of scope
  error          text,
  run_url        text                      -- GitHub Actions run, if any
);

create table if not exists bench.observations (
  observation_id bigint generated always as identity primary key,
  source_id      text not null references bench.sources (source_id),
  dataset        text not null,            -- 'finres' | 'nidr_cases' | 'ears_net_atlas'
  release        text not null,            -- report edition, export date, or 'live'
  table_ref      text,                     -- where in the source the value sits, e.g. 'Taulukko 11, p. 26'
  import_run_id  bigint references bench.import_runs (run_id) on delete set null,
  source_url     text not null,
  retrieved_at   timestamptz not null,

  period_type    text not null default 'year' check (period_type = 'year'),
  period_start   date not null,
  period_end     date not null,

  geo_level      text not null check (geo_level in ('eu_eea', 'country', 'county')),
  geo_code       text not null,
  geo_name       text not null,

  organism       text not null,            -- Latin name, aligned with ref.organisms where it exists
  organism_src   text not null,            -- label exactly as the source writes it
  antimicrobial  text not null default '', -- '' = not applicable (phenotype or case-count rows)
  antimicrobial_src text not null default '',
  phenotype      text not null default '', -- 'ESBL' | 'MRSA' | 'VRE' | 'CPE' | '' (shares of isolates, or notified cases)
  specimen       text not null check (specimen in ('blood_csf', 'urine', 'pus', 'carriage', 'all')),
  sex            text not null default 'all' check (sex in ('all', 'female', 'male')),
  age_band       text not null default 'all',

  indicator      text not null check (indicator in ('pct_resistant', 'cases', 'incidence_per_100k')),
  value          numeric not null,
  unit           text not null,
  numerator      int,                      -- only when the source publishes it
  denominator    bigint,                   -- isolates tested, or population for incidence; only when published
  ci_low         numeric,
  ci_high        numeric,

  breakpoint_standard text,
  dedup_rule     text,
  case_definition text,
  coverage_note  text,
  value_status   text not null default 'published' check (value_status in ('published', 'derived')),
  derivation     text,

  constraint observations_natural_key unique (
    source_id, dataset, release, indicator, period_start, period_end,
    geo_level, geo_code, organism, antimicrobial, phenotype, specimen, sex, age_band
  ),
  constraint observations_period_order check (period_end >= period_start),
  constraint observations_pct_range check (indicator <> 'pct_resistant' or value between 0 and 100),
  constraint observations_nonnegative check (
    value >= 0 and (denominator is null or denominator >= 0) and (numerator is null or numerator >= 0)
  ),
  constraint observations_derived_explained check (value_status = 'published' or derivation is not null)
);
create index if not exists observations_lookup_idx
  on bench.observations (organism, antimicrobial, phenotype, specimen, geo_code, period_start);

-- Which external series may be drawn next to which local rate (BUILD_PLAN.md §3.3). No row, no comparison.
create table if not exists ref.benchmark_comparability (
  source_id       text not null references bench.sources (source_id),
  organism        text not null references ref.organisms (name),
  antibiotic_code text not null,           -- local: WHONET code or phenotype marker (agg.rates.antibiotic_code)
  specimen        text not null check (specimen in ('urine', 'blood', 'wound', 'all')),   -- local specimen
  ext_antimicrobial text not null default '',
  ext_phenotype   text not null default '',
  ext_specimen    text not null check (ext_specimen in ('blood_csf', 'urine', 'pus', 'carriage', 'all')),
  sex             text not null default 'all' check (sex in ('all', 'female', 'male')),
  comparable      boolean not null,
  comparison_kind text not null check (comparison_kind in ('same_agent', 'phenotype', 'group_proxy')),
  caveat          text not null,
  primary key (source_id, organism, antibiotic_code, specimen, ext_antimicrobial, ext_phenotype, ext_specimen, sex)
);

-- Same access model as every other private table: RLS on, no policies, nothing for anon/authenticated.
alter table bench.sources enable row level security;
alter table bench.import_runs enable row level security;
alter table bench.observations enable row level security;
alter table ref.benchmark_comparability enable row level security;
revoke all on bench.sources, bench.import_runs, bench.observations, ref.benchmark_comparability from anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- api views. api.benchmarks keeps its column names so existing readers keep working; it now shows only
-- comparable, all-sex resistant shares, newest release per series. Sex-specific series, counts and
-- incidence go to their own views so they can never be mistaken for a hospital-wide percentage.
-- ---------------------------------------------------------------------------------------------
drop view if exists api.benchmarks, api.benchmarks_by_sex, api.external_context, api.external_sources;

create view api.benchmarks as
select distinct on (c.organism, c.antibiotic_code, c.specimen, o.source_id, o.geo_code, o.period_start)
  c.organism, c.antibiotic_code, c.specimen,
  coalesce(nullif(o.antimicrobial_src, ''), o.phenotype) as antimicrobial_group,
  case c.ext_specimen when 'blood_csf' then 'invasive' when 'urine' then 'urine' else 'all' end as specimen_scope,
  s.name as source, o.geo_code as country, extract(year from o.period_start)::int as year,
  o.denominator as n_tested, o.value as pct_r, o.ci_low, o.ci_high, o.retrieved_at, o.source_url,
  o.dataset, o.release, c.comparison_kind, c.caveat, s.attribution, s.licence
from bench.observations o
join ref.benchmark_comparability c
  on c.source_id = o.source_id and c.organism = o.organism
 and c.ext_antimicrobial = o.antimicrobial and c.ext_phenotype = o.phenotype
 and c.ext_specimen = o.specimen and c.sex = o.sex
join bench.sources s on s.source_id = o.source_id
where o.indicator = 'pct_resistant' and c.comparable and o.sex = 'all' and o.age_band = 'all'
order by c.organism, c.antibiotic_code, c.specimen, o.source_id, o.geo_code, o.period_start, o.release desc;

create view api.benchmarks_by_sex as
select distinct on (c.organism, c.antibiotic_code, c.specimen, o.source_id, o.geo_code, o.sex, o.period_start)
  c.organism, c.antibiotic_code, c.specimen, o.sex,
  coalesce(nullif(o.antimicrobial_src, ''), o.phenotype) as antimicrobial_group,
  case c.ext_specimen when 'blood_csf' then 'invasive' when 'urine' then 'urine' else 'all' end as specimen_scope,
  s.name as source, o.geo_code as country, extract(year from o.period_start)::int as year,
  o.denominator as n_tested, o.value as pct_r, o.ci_low, o.ci_high, o.retrieved_at, o.source_url,
  o.dataset, o.release, c.comparison_kind, c.caveat, s.attribution, s.licence
from bench.observations o
join ref.benchmark_comparability c
  on c.source_id = o.source_id and c.organism = o.organism
 and c.ext_antimicrobial = o.antimicrobial and c.ext_phenotype = o.phenotype
 and c.ext_specimen = o.specimen and c.sex = o.sex
join bench.sources s on s.source_id = o.source_id
where o.indicator = 'pct_resistant' and c.comparable and o.sex <> 'all' and o.age_band = 'all'
order by c.organism, c.antibiotic_code, c.specimen, o.source_id, o.geo_code, o.sex, o.period_start, o.release desc;

-- Notified cases and incidence (and any series with no comparability row): context only, never a resistance rate.
create view api.external_context as
select
  s.name as source, o.dataset, o.release, o.indicator, o.organism, o.phenotype, o.specimen,
  o.geo_level, o.geo_code, o.geo_name, extract(year from o.period_start)::int as year,
  o.value, o.unit, o.numerator, o.denominator, o.case_definition, o.retrieved_at, o.source_url,
  s.attribution, s.licence
from bench.observations o
join bench.sources s using (source_id)
where o.indicator in ('cases', 'incidence_per_100k') and o.sex = 'all' and o.age_band = 'all';

create view api.external_sources as
select
  s.source_id, s.name, s.publisher, s.landing_url, s.access_method, s.licence, s.attribution,
  s.methodology, s.update_cadence,
  (select max(r.finished_at) from bench.import_runs r where r.source_id = s.source_id and r.status = 'succeeded')
    as last_import_at
from bench.sources s;

grant select on api.benchmarks, api.benchmarks_by_sex, api.external_context, api.external_sources
  to anon, authenticated, service_role;

-- AMR Watch: staging (raw export) and lab (released, cleaned) tables (BUILD_PLAN.md §3.1, §3.2, §4.1).

-- staging: the CSVs as delivered, plus week_idx computed by pipeline/seed.py. Never modified after seed.
create table if not exists staging.patients (
  patient_id text primary key,
  sex        text,
  birth_year int,
  home_area  text
);

create table if not exists staging.cultures (
  culture_id     text primary key,
  patient_id     text not null,
  age_years      int,
  sample_date    date not null,
  iso_year       int not null,
  iso_week       int not null,
  week_idx       int not null,
  ward_code      text,
  ward_fi        text,
  ward_en        text,
  ward_type      text,
  institution    text,
  admission_date date,
  specimen       text,
  specimen_fi    text,
  result         text,
  n_isolates     int
);
create index if not exists cultures_week_idx_idx on staging.cultures (week_idx);

create table if not exists staging.isolates (
  isolate_id text primary key,
  culture_id text not null,
  isolate_no int,
  organism   text,
  quantity   text,
  esbl       int,
  mrsa       int,
  vre        int,
  cpe        int
);
create index if not exists isolates_culture_id_idx on staging.isolates (culture_id);

create table if not exists staging.susceptibility (
  isolate_id      text not null,
  culture_id      text not null,
  organism        text,
  antibiotic      text,
  antibiotic_code text not null,
  antibiotic_fi   text,
  result          text,
  guideline       text,
  primary key (isolate_id, antibiotic_code)
);
create index if not exists susceptibility_culture_id_idx on staging.susceptibility (culture_id);

-- lab: one row per released culture / isolate / AST result, cleaned and flagged by pipeline/clean.py.
create table if not exists lab.cultures (
  culture_id     text primary key,
  patient_id     text not null,
  sample_date    date not null,
  week_idx       int not null,
  iso_year       int,
  iso_week       int,
  ward_code      text references ref.wards (ward_code),
  setting        text check (setting in ('inpatient', 'ed', 'primary_care')),
  specimen       text,
  admission_date date,
  onset          text check (onset in ('hospital', 'community', 'outpatient', 'unknown')),
  age_years      int,
  age_band       text,
  sex            text,
  result         text,
  n_isolates     int
);
create index if not exists cultures_week_idx_idx on lab.cultures (week_idx);

create table if not exists lab.isolates (
  isolate_id text primary key,
  culture_id text not null references lab.cultures (culture_id) on delete cascade,
  organism   text references ref.organisms (name),
  quantity   text,
  esbl       bool not null default false,
  mrsa       bool not null default false,
  vre        bool not null default false,
  cpe        bool not null default false
);
create index if not exists isolates_culture_id_idx on lab.isolates (culture_id);

create table if not exists lab.susceptibility (
  isolate_id      text references lab.isolates (isolate_id) on delete cascade,
  antibiotic_code text references ref.antibiotics (antibiotic_code),
  result          char(1) check (result in ('S', 'R')),
  guideline       text,
  is_intrinsic    bool not null default false,   -- R1: excluded from every rate
  reportable      bool not null default true,    -- R2: urine-only agent on a non-urine specimen
  primary key (isolate_id, antibiotic_code)
);

-- Rows that failed standardisation (R6) or validation: counted, never silently dropped.
create table if not exists lab.rejects (
  run_id     text not null,
  week_idx   int,
  table_name text not null,
  row_key    text not null,
  reason     text not null,
  created_at timestamptz not null default now(),
  primary key (table_name, row_key, reason)
);

-- Single-row replay cursor: the last ISO week (week_idx) released into lab.*.
create table if not exists lab.replay_state (
  id              int primary key default 1 check (id = 1),
  cursor_week_idx int not null default 0,
  updated_at      timestamptz not null default now(),
  run_id          text
);
insert into lab.replay_state (id, cursor_week_idx) values (1, 0)
on conflict do nothing;

-- Per-run, per-week data-quality counts and validation checks (R8), shown on the quality page.
create table if not exists lab.dq_log (
  run_id     text not null,
  week_idx   int not null,
  check_name text not null,
  value      numeric,
  status     text not null check (status in ('info', 'pass', 'warn', 'fail')),
  detail     text,
  created_at timestamptz not null default now(),
  primary key (run_id, week_idx, check_name)
);

-- One row per pipeline run (advance -> clean -> aggregate -> detect -> feed -> log).
create table if not exists lab.pipeline_runs (
  run_id          text primary key,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  status          text not null default 'running' check (status in ('running', 'success', 'failed')),
  cursor_from     int,
  cursor_to       int,
  steps           jsonb not null default '{}'::jsonb,
  run_url         text,
  error           text
);

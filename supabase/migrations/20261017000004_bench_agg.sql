-- AMR Watch: benchmark and aggregate tables (BUILD_PLAN.md §4.1, §4.2, §7.6, §8.4).

create table if not exists bench.rates (
  source              text not null,          -- 'ECDC' | 'THL' | 'WHO GLASS'
  country             text not null,
  year                int not null,
  organism            text not null,
  antimicrobial_group text not null,
  specimen_scope      text not null check (specimen_scope in ('invasive', 'urine', 'all')),
  n_tested            int,
  pct_r               numeric,
  ci_low              numeric,
  ci_high             numeric,
  retrieved_at        timestamptz,
  source_url          text,
  primary key (source, country, year, organism, antimicrobial_group, specimen_scope)
);

-- Window rates materialised by pipeline/aggregate.py. First-isolate de-duplication is applied
-- within each window (and within each scope), so these cannot be a live SQL view.
create table if not exists agg.rates (
  end_week_idx    int not null,
  window_weeks    int not null check (window_weeks in (1, 4, 8, 13, 52)),
  organism        text not null,
  antibiotic_code text not null,               -- WHONET code, or phenotype marker 'ESBL','MRSA','VRE','CPE'
  specimen        text not null,               -- 'urine' | 'blood' | 'wound' | 'all'
  scope_type      text not null check (scope_type in ('hospital', 'ward', 'setting', 'onset')),
  scope_value     text not null,               -- 'ALL' | ward code | setting | onset
  n_tested        int not null,                -- first isolates tested (denominator)
  n_resistant     int not null,                -- numerator
  pct_r           numeric,
  wilson_low      numeric,
  wilson_high     numeric,
  reportable      bool not null,               -- n_tested >= 30
  primary key (end_week_idx, window_weeks, organism, antibiotic_code, specimen, scope_type, scope_value)
);
create index if not exists rates_organism_antibiotic_code_specimen_scope_type_scope_va_idx on agg.rates (organism, antibiotic_code, specimen, scope_type, scope_value, window_weeks, end_week_idx);

-- Optional exploration splits (sex, age_band), 52-week window only. Same shape as agg.rates.
create table if not exists agg.rates_demo (like agg.rates including all);

-- Alert episodes and firings (BUILD_PLAN.md §7.6). Written by pipeline/detect.py.
create table if not exists agg.alert_episodes (
  episode_id      text primary key,
  key             text not null unique,        -- signal|organism|marker_or_antibiotic|specimen|scope_type|scope_value
  signal_type     text not null check (signal_type in ('rate', 'count', 'sentinel', 'drift')),
  organism        text,
  antibiotic_code text,                        -- WHONET code or phenotype marker
  specimen        text,
  scope_type      text,
  scope_value     text,
  opened_week     int not null,
  last_fired_week int not null,
  status          text not null default 'open'
                  check (status in ('open', 'escalated', 'resolved', 'acknowledged', 'dismissed')),
  severity        text check (severity in ('low', 'medium', 'high', 'critical')),
  severity_points int,
  confidence      text check (confidence in ('low', 'medium', 'high')),
  rank            numeric,
  explanation     text,                        -- template sentence filled from evidence JSON
  status_note     text,
  updated_at      timestamptz not null default now()
);

create table if not exists agg.alert_firings (
  episode_id text not null references agg.alert_episodes (episode_id) on delete cascade,
  week_idx   int not null,
  evidence   jsonb not null,                   -- see BUILD_PLAN.md §7.4
  created_at timestamptz not null default now(),
  primary key (episode_id, week_idx)
);

-- What each RSS feed has published, so items are never duplicated or silently changed (§8.4).
create table if not exists agg.feed_log (
  item_guid    text not null,
  feed         text not null,
  episode_id   text references agg.alert_episodes (episode_id) on delete set null,
  published_at timestamptz not null default now(),
  primary key (item_guid, feed)
);

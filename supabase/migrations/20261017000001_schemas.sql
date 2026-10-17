-- AMR Watch: schemas (BUILD_PLAN.md §4).
-- Only `api` is exposed through the Supabase REST API (Settings -> API -> Exposed schemas).
-- Every other schema is private to the pipeline (service role / direct DB connection).

create schema if not exists staging;  -- raw CSVs, all 156 weeks, never modified after seed
create schema if not exists lab;      -- results released so far by the weekly replay, cleaned + flagged
create schema if not exists ref;      -- organisms, antibiotics, wards, intrinsic resistance, rule config
create schema if not exists bench;    -- national / EU benchmark rates (THL, ECDC, WHO GLASS)
create schema if not exists agg;      -- window rates, alerts, feed log (written by the pipeline)
create schema if not exists api;      -- read-only aggregate views for the dashboard and assistant

comment on schema staging is 'Raw synthetic LIS export, all weeks. Replay job only.';
comment on schema lab is 'Lab results released so far by the weekly replay, cleaned and flagged. Pipeline only.';
comment on schema ref is 'Reference data and rule configuration.';
comment on schema bench is 'Annual national / European benchmark rates.';
comment on schema agg is 'Aggregates and alerts materialised by the pipeline.';
comment on schema api is 'Read-only, aggregate-only views. The only schema exposed to the browser.';

-- ISO-week helpers. week_idx 1 = 2023-W40 (Monday 2023-10-02), 156 = 2026-W39.
create or replace function ref.week_start(p_week_idx int) returns date
language sql immutable parallel safe as $$
  select date '2023-10-02' + (p_week_idx - 1) * 7
$$;

create or replace function ref.week_label(p_week_idx int) returns text
language sql immutable parallel safe as $$
  select to_char(ref.week_start(p_week_idx), 'IYYY-"W"IW')
$$;

-- Wilson score interval (95%, z = 1.96), mirrored from pipeline/stats.py for ad hoc checks.
-- Returns percentages (0-100) to match agg.rates.pct_r.
create or replace function ref.wilson_low(x int, n int, z numeric default 1.96) returns numeric
language sql immutable parallel safe as $$
  select case when n is null or n <= 0 then null else
    100 * ((x::numeric / n + z * z / (2 * n))
           - z * sqrt((x::numeric / n) * (1 - x::numeric / n) / n + z * z / (4.0 * n * n)))
        / (1 + z * z / n)
  end
$$;

create or replace function ref.wilson_high(x int, n int, z numeric default 1.96) returns numeric
language sql immutable parallel safe as $$
  select case when n is null or n <= 0 then null else
    100 * ((x::numeric / n + z * z / (2 * n))
           + z * sqrt((x::numeric / n) * (1 - x::numeric / n) / n + z * z / (4.0 * n * n)))
        / (1 + z * z / n)
  end
$$;

-- AMR Watch: read-only api views and security (BUILD_PLAN.md §4.3).
-- Views are owned by the migration role, so they can read agg/bench/ref without exposing them.
-- No view returns a patient_id, birth year or exact sample date: the smallest time unit is the ISO week.

-- Views are derived, so they are dropped and recreated: this file can be re-applied safely
-- (including over the first version, whose picker views had no ref_ prefix).
drop view if exists
  api.replay_status, api.rate_series, api.current_vs_baseline, api.antibiogram, api.heatmap,
  api.intrinsic_resistance, api.ref_intrinsic_resistance, api.ward_comparison, api.benchmarks,
  api.alerts, api.alert_detail, api.data_quality, api.pipeline_runs,
  api.organisms, api.antibiotics, api.wards, api.phenotypes,
  api.ref_organisms, api.ref_antibiotics, api.ref_wards, api.ref_phenotypes, api.ref_weeks
  cascade;

-- Data-through banner.
create view api.replay_status as
select
  s.cursor_week_idx,
  case when s.cursor_week_idx > 0 then ref.week_label(s.cursor_week_idx) end as data_through,
  case when s.cursor_week_idx > 0 then ref.week_start(s.cursor_week_idx) end as week_start,
  s.updated_at,
  r.run_id        as last_run_id,
  r.status        as last_run_status,
  r.finished_at   as last_run_finished_at,
  r.run_url       as last_run_url,
  (select count(*) from lab.isolates i join lab.cultures c using (culture_id)
    where c.week_idx = s.cursor_week_idx)::int as isolates_this_week
from lab.replay_state s
left join lateral (
  select * from lab.pipeline_runs order by started_at desc limit 1
) r on true;

-- Trend charts: every window rate up to the cursor.
create view api.rate_series as
select
  r.end_week_idx,
  ref.week_label(r.end_week_idx) as end_week,
  r.window_weeks, r.organism, r.antibiotic_code, r.specimen, r.scope_type, r.scope_value,
  r.n_tested, r.n_resistant, r.pct_r, r.wilson_low, r.wilson_high, r.reportable
from agg.rates r
where r.end_week_idx <= (select cursor_week_idx from lab.replay_state where id = 1);

-- Section A tiles: last 4 weeks vs the 52 weeks before them, at the cursor.
-- When the 4-week window has n < 30 the current window auto-widens to 8, then 13 weeks
-- (current_window_weeks says which was used); the baseline is always the 52 weeks before
-- the current window, matching the anomaly engine (§7.2).
create view api.current_vs_baseline as
with cur as (
  select cursor_week_idx as w from lab.replay_state where id = 1
), base as (
  select r4.*, cur.w
  from cur
  join agg.rates r4 on r4.end_week_idx = cur.w and r4.window_weeks = 4
)
select
  b.organism, b.antibiotic_code, b.specimen, b.scope_type, b.scope_value,
  b.w                    as end_week_idx,
  ref.week_label(b.w)    as end_week,
  b.n_tested             as n_4w,
  b.n_resistant          as x_4w,
  b.pct_r                as pct_r_4w,
  b.wilson_low           as wilson_low_4w,
  b.wilson_high          as wilson_high_4w,
  b.reportable           as reportable_4w,
  coalesce(wide.window_weeks, 4)        as current_window_weeks,
  coalesce(wide.n_tested, b.n_tested)   as n_current,
  coalesce(wide.n_resistant, b.n_resistant) as x_current,
  coalesce(wide.pct_r, b.pct_r)         as pct_r_current,
  coalesce(wide.wilson_low, b.wilson_low)   as wilson_low_current,
  coalesce(wide.wilson_high, b.wilson_high) as wilson_high_current,
  (wide.window_weeks is not null)       as reportable_current,
  bl.n_tested            as n_52w,
  bl.n_resistant         as x_52w,
  bl.pct_r               as pct_r_52w,
  bl.wilson_low          as wilson_low_52w,
  bl.wilson_high         as wilson_high_52w,
  bl.reportable          as reportable_52w,
  round(coalesce(wide.pct_r, b.pct_r) - bl.pct_r, 1) as delta_pp,
  -- Arrow colouring rule from §6.3: only when the two CIs do not overlap.
  (coalesce(wide.wilson_low, b.wilson_low) > bl.wilson_high
   or coalesce(wide.wilson_high, b.wilson_high) < bl.wilson_low) as ci_separated
from base b
left join lateral (
  select x.* from agg.rates x
  where x.end_week_idx = b.w and x.window_weeks in (4, 8, 13) and x.reportable
    and x.organism = b.organism and x.antibiotic_code = b.antibiotic_code and x.specimen = b.specimen
    and x.scope_type = b.scope_type and x.scope_value = b.scope_value
  order by x.window_weeks
  limit 1
) wide on true
left join agg.rates bl
  on bl.end_week_idx = b.w - coalesce(wide.window_weeks, 4) and bl.window_weeks = 52
 and bl.organism = b.organism and bl.antibiotic_code = b.antibiotic_code and bl.specimen = b.specimen
 and bl.scope_type = b.scope_type and bl.scope_value = b.scope_value;

-- Ward antibiogram: organism x antibiotic x ward (and hospital), %S and %R, 4w and 52w at the cursor.
create view api.antibiogram as
with cur as (
  select cursor_week_idx as w from lab.replay_state where id = 1
), r as (
  select r.* from agg.rates r, cur
  where r.end_week_idx = cur.w and r.window_weeks in (4, 52)
    and r.scope_type in ('hospital', 'ward') and r.antibiotic_code not in ('ESBL', 'MRSA', 'VRE', 'CPE')
)
select
  k.organism, k.antibiotic_code, k.specimen, k.scope_type, k.scope_value,
  cur.w as end_week_idx,
  ref.week_label(cur.w) as end_week,
  a.n_tested as n_4w,  a.n_resistant as x_4w,  100 - a.pct_r as pct_s_4w,  a.pct_r as pct_r_4w,  coalesce(a.reportable, false) as reportable_4w,
  y.n_tested as n_52w, y.n_resistant as x_52w, 100 - y.pct_r as pct_s_52w, y.pct_r as pct_r_52w, coalesce(y.reportable, false) as reportable_52w
from cur
cross join (select distinct organism, antibiotic_code, specimen, scope_type, scope_value from r) k
left join r a
  on a.window_weeks = 4 and a.organism = k.organism and a.antibiotic_code = k.antibiotic_code
 and a.specimen = k.specimen and a.scope_type = k.scope_type and a.scope_value = k.scope_value
left join r y
  on y.window_weeks = 52 and y.organism = k.organism and y.antibiotic_code = k.antibiotic_code
 and y.specimen = k.specimen and y.scope_type = k.scope_type and y.scope_value = k.scope_value;

-- Section C heatmap: organism x antibiotic for any window/scope up to the cursor.
-- Intrinsic pairs never appear here (they are excluded from rates); overlay api.ref_intrinsic_resistance as "IR".
create view api.heatmap as
select
  r.end_week_idx, ref.week_label(r.end_week_idx) as end_week, r.window_weeks,
  r.organism, o.short_name, r.antibiotic_code, r.specimen, r.scope_type, r.scope_value,
  r.n_tested, r.n_resistant, r.pct_r, r.wilson_low, r.wilson_high, r.reportable,
  false as is_intrinsic
from agg.rates r
join ref.organisms o on o.name = r.organism
where r.end_week_idx <= (select cursor_week_idx from lab.replay_state where id = 1)
  and r.antibiotic_code not in ('ESBL', 'MRSA', 'VRE', 'CPE');

create view api.ref_intrinsic_resistance as
select organism, antibiotic_code, source from ref.intrinsic_resistance;

-- Forest plot: one row per ward with the hospital rate alongside.
create view api.ward_comparison as
select
  w.end_week_idx, ref.week_label(w.end_week_idx) as end_week, w.window_weeks,
  w.organism, w.antibiotic_code, w.specimen,
  w.scope_value as ward_code, wd.ward_en,
  w.n_tested, w.n_resistant, w.pct_r, w.wilson_low, w.wilson_high, w.reportable,
  h.n_tested as hospital_n_tested, h.pct_r as hospital_pct_r,
  h.wilson_low as hospital_wilson_low, h.wilson_high as hospital_wilson_high
from agg.rates w
join ref.wards wd on wd.ward_code = w.scope_value
left join agg.rates h
  on h.end_week_idx = w.end_week_idx and h.window_weeks = w.window_weeks
 and h.organism = w.organism and h.antibiotic_code = w.antibiotic_code and h.specimen = w.specimen
 and h.scope_type = 'hospital' and h.scope_value = 'ALL'
where w.scope_type = 'ward'
  and w.end_week_idx <= (select cursor_week_idx from lab.replay_state where id = 1);

-- Benchmark overlay lines, mapped to our organism + code. Rows without a mapping get no line.
create view api.benchmarks as
select
  m.organism, m.antibiotic_code, m.specimen, b.antimicrobial_group, b.specimen_scope,
  b.source, b.country, b.year, b.n_tested, b.pct_r, b.ci_low, b.ci_high, b.retrieved_at, b.source_url
from bench.rates b
join ref.benchmark_mapping m
  on m.organism = b.organism and m.antimicrobial_group = b.antimicrobial_group
 and m.specimen_scope = b.specimen_scope;

-- Alerts (shape owned by detect.py; extend in a later migration if needed).
create view api.alerts as
select
  e.episode_id, e.signal_type, e.organism, e.antibiotic_code, e.specimen, e.scope_type, e.scope_value,
  e.opened_week, ref.week_label(e.opened_week) as opened_week_label,
  e.last_fired_week, ref.week_label(e.last_fired_week) as last_fired_week_label,
  e.status, e.severity, e.confidence, e.rank, e.explanation, e.updated_at,
  f.evidence as latest_evidence
from agg.alert_episodes e
left join lateral (
  select evidence from agg.alert_firings f where f.episode_id = e.episode_id
  order by week_idx desc limit 1
) f on true
where e.opened_week <= (select cursor_week_idx from lab.replay_state where id = 1);

create view api.alert_detail as
select f.episode_id, f.week_idx, ref.week_label(f.week_idx) as week, f.evidence
from agg.alert_firings f
where f.week_idx <= (select cursor_week_idx from lab.replay_state where id = 1);

-- Quality page: per-run counts, checks and exclusions.
create view api.data_quality as
select
  d.run_id, d.week_idx, ref.week_label(d.week_idx) as week, d.check_name, d.value, d.status, d.detail,
  r.started_at as run_started_at, r.status as run_status, r.run_url
from lab.dq_log d
left join lab.pipeline_runs r using (run_id);

create view api.pipeline_runs as
select run_id, started_at, finished_at, status, cursor_from, cursor_to, steps, run_url, error
from lab.pipeline_runs;

-- Filter pickers and labels.
create view api.ref_organisms as select name, short_name, whonet_code, gram, org_group from ref.organisms;
create view api.ref_antibiotics as
  select antibiotic_code, antibiotic, antibiotic_fi, class, reported_for from ref.antibiotics;
create view api.ref_wards as select ward_code, ward_fi, ward_en, ward_type, institution from ref.wards;
create view api.ref_phenotypes as select marker, organism from ref.phenotypes;
create view api.ref_weeks as
  select g as week_idx, ref.week_label(g) as label, ref.week_start(g) as week_start
  from generate_series(1, 156) g;

-- ---------------------------------------------------------------------------------------------
-- Security: RLS on every table (no policies = no direct access for anon/authenticated);
-- anon and authenticated may only select from api.*. The service role is used only in Actions.
-- ---------------------------------------------------------------------------------------------
do $$
declare t record;
begin
  for t in
    select schemaname, tablename from pg_tables
    where schemaname in ('staging', 'lab', 'ref', 'bench', 'agg')
  loop
    execute format('alter table %I.%I enable row level security', t.schemaname, t.tablename);
  end loop;
end $$;

revoke all on schema staging, lab, ref, bench, agg from anon, authenticated;
revoke all on all tables in schema staging, lab, ref, bench, agg from anon, authenticated;

grant usage on schema api to anon, authenticated, service_role;
grant select on all tables in schema api to anon, authenticated, service_role;
alter default privileges in schema api grant select on tables to anon, authenticated, service_role;

-- The views call ref.week_label; the functions run with the caller's rights.
grant usage on schema ref to anon, authenticated;
grant execute on function ref.week_start(int), ref.week_label(int) to anon, authenticated;
revoke all on all tables in schema ref from anon, authenticated;

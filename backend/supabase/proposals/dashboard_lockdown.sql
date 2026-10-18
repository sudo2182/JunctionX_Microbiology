-- PROPOSAL, NOT APPLIED. Kept out of supabase/migrations/ on purpose so the migrate workflow does not run it.
-- To adopt it: review, move it into supabase/migrations/ with the next version number, and merge to main.
-- The speed fix it contains was applied separately as 20261018000003_dashboard_records_view.sql.
-- Note: the live database also has Lovable's PAN-alert functions and triggers (public.amr_*, including triggers
-- on lab.isolates / lab.susceptibility and a news_items.detection_key column). They are not captured here.
--
-- AMR Watch: the Lovable dashboard's (Kasper/) database contract, brought under version control.
--
-- The dashboard reads per-isolate rows from public.records / public.ward_stays, writes its own entries to
-- public.record_submissions / public.news_items, and reads labels from api.ref_wards, api.ref_antibiotics and
-- api.ref_organisms. Lovable created the public objects directly in the database (outside this folder) as
-- security-invoker views, which needed anon SELECT grants and open RLS policies on lab.*. This migration:
--   1. recreates both views with owner rights (like every api.* view), so lab.* goes back to private;
--   2. builds the susceptibility strings per isolate, so a 1000-row page no longer aggregates all of lab.susceptibility;
--   3. records the two dashboard tables and their policies here, and trims anon grants to what the app uses.
-- Safe to re-apply.

-- ---------------------------------------------------------------------------------------------
-- 1 + 2. Read path. Column names, types and order are unchanged (create or replace keeps them).
-- ---------------------------------------------------------------------------------------------
create or replace view public.records as
select
  i.isolate_id                                  as id,
  c.patient_id,
  c.sex,
  c.age_years                                   as age,
  c.age_band,
  c.sample_date,
  c.admission_date,
  c.week_idx,
  c.ward_code                                   as ward,
  w.ward_en,
  w.ward_fi,
  w.ward_type,
  w.institution,
  c.setting,
  c.specimen,
  c.onset,
  i.organism,
  o.short_name                                  as organism_short,
  o.gram,
  o.org_group,
  i.quantity,
  i.esbl,
  i.mrsa,
  i.vre,
  i.cpe,
  (case when i.esbl then 1 else 0 end
   + case when i.mrsa then 2 else 0 end
   + case when i.vre  then 4 else 0 end
   + case when i.cpe  then 8 else 0 end)::smallint as markers,
  -- Correlated subqueries (one index lookup per isolate) instead of a GROUP BY over every AST row: Postgres
  -- evaluates them after ORDER BY/LIMIT, so paging stays cheap.
  (select coalesce(string_agg(a.antibiotic_code || ':' || a.result, ',' order by a.antibiotic_code), '')
     from lab.susceptibility a where a.isolate_id = i.isolate_id)                       as susceptibility,
  (select coalesce(string_agg(a.antibiotic_code, ',' order by a.antibiotic_code), '')
     from lab.susceptibility a where a.isolate_id = i.isolate_id and a.is_intrinsic)    as intrinsic,
  c.result                                      as culture_result
from lab.isolates i
join lab.cultures c  on c.culture_id = i.culture_id
join ref.wards w     on w.ward_code  = c.ward_code
join ref.organisms o on o.name       = i.organism;

create or replace view public.ward_stays as
select
  c.culture_id                                  as id,
  c.patient_id,
  c.sample_date,
  c.admission_date,
  c.week_idx,
  c.ward_code                                   as ward,
  w.ward_type,
  w.institution,
  c.setting,
  c.specimen,
  c.onset,
  c.result,
  c.n_isolates
from lab.cultures c
join ref.wards w on w.ward_code = c.ward_code;

alter view public.records    reset (security_invoker);
alter view public.ward_stays reset (security_invoker);

comment on view public.records is
  'Dashboard read path: one row per released isolate with its AST results as "CODE:R,CODE:S". Owner rights; lab.* stays private.';
comment on view public.ward_stays is
  'Dashboard read path: one row per released culture (including negatives), for estimated ward occupancy.';

-- Views are read-only for the app.
revoke all on public.records, public.ward_stays from anon, authenticated;
grant select on public.records, public.ward_stays to anon, authenticated, service_role;

-- lab.* back to private (as 20261017000005_api_views intended). ref.* stays readable only through api.ref_*.
drop policy if exists "Dashboard reads cultures"       on lab.cultures;
drop policy if exists "Dashboard reads isolates"       on lab.isolates;
drop policy if exists "Dashboard reads susceptibility" on lab.susceptibility;
drop policy if exists "Dashboard reads wards"          on ref.wards;
drop policy if exists "Dashboard reads organisms"      on ref.organisms;
revoke all on lab.cultures, lab.isolates, lab.susceptibility, ref.wards, ref.organisms from anon, authenticated;
revoke usage on schema lab from anon, authenticated;

-- ---------------------------------------------------------------------------------------------
-- 3. Write path. Same definitions Lovable applied; `if not exists` keeps existing rows.
-- The dashboard has no sign-in (a deliberate choice), so anyone with the page can add and remove
-- these rows. They never reach lab.* or agg.*: nothing in the pipeline reads them.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.record_submissions (
  id             uuid primary key default gen_random_uuid(),
  batch_id       uuid,
  patient_id     text not null,
  sex            text not null,
  age_years      integer not null,
  sample_date    date not null,
  admission_date date,
  ward_code      text not null,
  specimen       text not null,
  organism       text not null,
  markers        smallint not null default 0,
  susceptibility text not null default '',
  note           text,
  source         text not null default 'dashboard',
  status         text not null default 'pending',
  submitted_at   timestamptz not null default now(),
  processed_at   timestamptz
);

create table if not exists public.news_items (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  summary    text not null default '',
  url        text,
  region     text,
  organism   text,
  severity   text not null default 'watch',
  alert_date date not null default current_date,
  source     text not null default 'news',
  posted_at  timestamptz not null default now()
);

alter table public.record_submissions enable row level security;
alter table public.news_items         enable row level security;

drop policy if exists "Anyone reads submitted records"   on public.record_submissions;
drop policy if exists "Anyone adds submitted records"    on public.record_submissions;
drop policy if exists "Anyone removes submitted records" on public.record_submissions;
create policy "Anyone reads submitted records"   on public.record_submissions for select to anon, authenticated using (true);
create policy "Anyone adds submitted records"    on public.record_submissions for insert to anon, authenticated with check (true);
create policy "Anyone removes submitted records" on public.record_submissions for delete to anon, authenticated using (true);

drop policy if exists "Anyone reads feed items"   on public.news_items;
drop policy if exists "Anyone posts feed items"   on public.news_items;
drop policy if exists "Anyone removes feed items" on public.news_items;
create policy "Anyone reads feed items"   on public.news_items for select to anon, authenticated using (true);
create policy "Anyone posts feed items"   on public.news_items for insert to anon, authenticated with check (true);
create policy "Anyone removes feed items" on public.news_items for delete to anon, authenticated using (true);

-- Only the verbs the dashboard uses (Supabase's defaults also grant update/truncate/trigger/references).
revoke all on public.record_submissions, public.news_items from anon, authenticated;
grant select, insert, delete on public.record_submissions, public.news_items to anon, authenticated;
grant all on public.record_submissions, public.news_items to service_role;

notify pgrst, 'reload schema';

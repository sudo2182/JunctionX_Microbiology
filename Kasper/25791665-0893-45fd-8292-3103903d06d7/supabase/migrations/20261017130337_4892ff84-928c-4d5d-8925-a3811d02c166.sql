-- ============================================================
-- 1. Remove the scratch objects from the earlier attempt
-- ============================================================
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();
drop table if exists public.isolates;
drop table if exists public.alerts;
drop table if exists public.user_roles;
drop function if exists public.has_role(uuid, public.app_role);
drop type if exists public.app_role;

-- ============================================================
-- 2. Per-isolate read path: culture context + susceptibility
-- ============================================================
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
  coalesce(string_agg(a.antibiotic_code || ':' || a.result, ',' order by a.antibiotic_code), '') as susceptibility,
  coalesce(string_agg(a.antibiotic_code, ',' order by a.antibiotic_code) filter (where a.is_intrinsic), '') as intrinsic,
  c.result                                      as culture_result
from lab.isolates i
join lab.cultures c on c.culture_id = i.culture_id
join ref.wards w    on w.ward_code  = c.ward_code
join ref.organisms o on o.name      = i.organism
left join lab.susceptibility a on a.isolate_id = i.isolate_id
group by
  i.isolate_id, c.patient_id, c.sex, c.age_years, c.age_band, c.sample_date, c.admission_date,
  c.week_idx, c.ward_code, w.ward_en, w.ward_fi, w.ward_type, w.institution, c.setting,
  c.specimen, c.onset, i.organism, o.short_name, o.gram, o.org_group, i.quantity,
  i.esbl, i.mrsa, i.vre, i.cpe, c.result;

-- ============================================================
-- 3. One row per culture, for estimated ward occupancy
-- ============================================================
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

-- ============================================================
-- 4. Records added from the dashboard, awaiting pipeline ingest
-- ============================================================
create table public.record_submissions (
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

grant select, insert on public.record_submissions to anon;
grant select, insert on public.record_submissions to authenticated;
grant all on public.record_submissions to service_role;

alter table public.record_submissions enable row level security;
create policy "Anyone reads submitted records" on public.record_submissions
  for select to anon, authenticated using (true);
create policy "Anyone adds submitted records" on public.record_submissions
  for insert to anon, authenticated with check (true);

-- ============================================================
-- 5. News and outbreak-alert feed
-- ============================================================
create table public.news_items (
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

grant select, insert on public.news_items to anon;
grant select, insert on public.news_items to authenticated;
grant all on public.news_items to service_role;

alter table public.news_items enable row level security;
create policy "Anyone reads feed items" on public.news_items
  for select to anon, authenticated using (true);
create policy "Anyone posts feed items" on public.news_items
  for insert to anon, authenticated with check (true);

-- ============================================================
-- 6. Let the data API pick up the new objects
-- ============================================================
NOTIFY pgrst, 'reload schema';
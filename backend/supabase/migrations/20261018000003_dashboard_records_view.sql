-- AMR Watch: faster public.records for the Lovable dashboard (Kasper/).
--
-- public.records was created by Lovable directly in the database (not in this folder). Its GROUP BY over every
-- lab.susceptibility row made each 1000-row page take ~1.2 s, so the dashboard needed ~25 s to load and timed
-- out (anon statement_timeout) when pages were requested in parallel. Here the AST strings are built per isolate
-- with correlated subqueries, which Postgres evaluates after ORDER BY/LIMIT: ~0.2 s per page.
--
-- Output is unchanged (same columns, types, order and rows). Access is unchanged too: the view stays
-- security_invoker, exactly as Lovable left it. create or replace resets view options, so it is set explicitly.
-- Safe to re-apply.

create or replace view public.records with (security_invoker = on) as
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
  (select coalesce(string_agg(a.antibiotic_code || ':' || a.result, ',' order by a.antibiotic_code), '')
     from lab.susceptibility a where a.isolate_id = i.isolate_id)                       as susceptibility,
  (select coalesce(string_agg(a.antibiotic_code, ',' order by a.antibiotic_code), '')
     from lab.susceptibility a where a.isolate_id = i.isolate_id and a.is_intrinsic)    as intrinsic,
  c.result                                      as culture_result
from lab.isolates i
join lab.cultures c  on c.culture_id = i.culture_id
join ref.wards w     on w.ward_code  = c.ward_code
join ref.organisms o on o.name       = i.organism;

comment on view public.records is
  'Dashboard read path: one row per released isolate with its AST results as "CODE:R,CODE:S".';

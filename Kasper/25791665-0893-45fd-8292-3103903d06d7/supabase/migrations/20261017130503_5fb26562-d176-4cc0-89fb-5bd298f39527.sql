-- ============================================================
-- Read the dashboard views as the caller, not as the owner, so the
-- access rules on the pipeline tables decide what is visible.
-- ============================================================
alter view public.records set (security_invoker = on);
alter view public.ward_stays set (security_invoker = on);

grant usage on schema lab, ref to anon, authenticated;

grant select on lab.cultures, lab.isolates, lab.susceptibility, ref.wards, ref.organisms
  to anon, authenticated, service_role;

create policy "Dashboard reads cultures" on lab.cultures
  for select to anon, authenticated using (true);
create policy "Dashboard reads isolates" on lab.isolates
  for select to anon, authenticated using (true);
create policy "Dashboard reads susceptibility" on lab.susceptibility
  for select to anon, authenticated using (true);
create policy "Dashboard reads wards" on ref.wards
  for select to anon, authenticated using (true);
create policy "Dashboard reads organisms" on ref.organisms
  for select to anon, authenticated using (true);

NOTIFY pgrst, 'reload schema';
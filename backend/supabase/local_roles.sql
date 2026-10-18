-- Vanilla-Postgres stand-ins for the roles Supabase provides, so the migrations can be applied
-- to a local database or the CI Postgres service. Do NOT run this against Supabase.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
end $$;

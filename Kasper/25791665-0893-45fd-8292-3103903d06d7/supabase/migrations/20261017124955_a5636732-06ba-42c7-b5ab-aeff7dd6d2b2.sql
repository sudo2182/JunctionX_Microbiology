-- Tighten the two new SECURITY DEFINER / role-check helpers.

-- has_role only ever reads the caller's own role row, so it does not need
-- definer privileges. Running as the caller also means it can be called by
-- signed-in staff without widening what they can see.
create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles where user_id = _user_id and role = _role
  )
$$;

revoke execute on function public.has_role(uuid, public.app_role) from public, anon;
grant execute on function public.has_role(uuid, public.app_role) to authenticated, service_role;

-- Role rows are managed in the database, not through the app. Removing this
-- policy also keeps has_role from recursing into user_roles.
drop policy if exists "Admins manage roles" on public.user_roles;

-- The signup trigger runs from the auth service, never from an app visitor.
revoke execute on function public.handle_new_user() from public, anon;
grant execute on function public.handle_new_user() to supabase_auth_admin, supabase_admin, service_role, postgres;
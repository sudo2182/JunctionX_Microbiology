-- AMR Watch: staff accounts, isolate records, alert feed

-- ---------- roles ----------
create type public.app_role as enum ('admin', 'user');

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  role public.app_role not null,
  unique (user_id, role)
);

GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles where user_id = _user_id and role = _role
  )
$$;

GRANT EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) TO authenticated, service_role;

create policy "Staff read own roles" on public.user_roles
  for select to authenticated using (user_id = auth.uid());

create policy "Admins manage roles" on public.user_roles
  for all to authenticated
  using (public.has_role(auth.uid(), 'admin'))
  with check (public.has_role(auth.uid(), 'admin'));

-- First account to register becomes the administrator; later accounts are staff.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from public.user_roles) then
    insert into public.user_roles (user_id, role) values (new.id, 'user');
  else
    insert into public.user_roles (user_id, role) values (new.id, 'admin');
  end if;
  return new;
end
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- isolates ----------
create table public.isolates (
  id text primary key,
  patient_id text not null,
  sex text not null,
  age integer not null,
  sample_date date not null,
  admission_date date,
  ward text not null,
  specimen text not null,
  home_area text not null,
  organism text not null,
  markers smallint not null default 0,
  susceptibility text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index isolates_sample_date_idx on public.isolates (sample_date);
create index isolates_ward_idx on public.isolates (ward);
create index isolates_organism_idx on public.isolates (organism);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.isolates TO authenticated;
GRANT ALL ON public.isolates TO service_role;

ALTER TABLE public.isolates ENABLE ROW LEVEL SECURITY;

create policy "Staff read isolates" on public.isolates
  for select to authenticated using (true);

create policy "Staff add isolates" on public.isolates
  for insert to authenticated with check (created_by = auth.uid());

create policy "Staff update own isolates" on public.isolates
  for update to authenticated
  using (created_by = auth.uid() or public.has_role(auth.uid(), 'admin'))
  with check (created_by = auth.uid() or public.has_role(auth.uid(), 'admin'));

create policy "Staff delete own isolates" on public.isolates
  for delete to authenticated
  using (created_by = auth.uid() or public.has_role(auth.uid(), 'admin'));

-- ---------- alert feed ----------
create table public.alerts (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  summary text not null default '',
  url text,
  region text,
  organism text,
  severity text not null default 'watch',
  alert_date date not null default current_date,
  source text not null default 'news',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.alerts TO authenticated;
GRANT ALL ON public.alerts TO service_role;

ALTER TABLE public.alerts ENABLE ROW LEVEL SECURITY;

create policy "Staff read alerts" on public.alerts
  for select to authenticated using (true);

create policy "Staff post alerts" on public.alerts
  for insert to authenticated with check (created_by = auth.uid());

create policy "Staff update own alerts" on public.alerts
  for update to authenticated
  using (created_by = auth.uid() or public.has_role(auth.uid(), 'admin'))
  with check (created_by = auth.uid() or public.has_role(auth.uid(), 'admin'));

create policy "Staff delete own alerts" on public.alerts
  for delete to authenticated
  using (created_by = auth.uid() or public.has_role(auth.uid(), 'admin'));
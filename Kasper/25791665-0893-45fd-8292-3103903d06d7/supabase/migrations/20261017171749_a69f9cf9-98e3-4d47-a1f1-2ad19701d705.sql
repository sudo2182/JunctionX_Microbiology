create type public.app_role as enum ('doctor', 'lab');

create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade not null,
  role public.app_role not null,
  unique (user_id, role)
);
grant select, insert on public.user_roles to authenticated;
grant all on public.user_roles to service_role;
alter table public.user_roles enable row level security;
create policy "Users read their own roles" on public.user_roles for select to authenticated using (auth.uid() = user_id);
create policy "Users choose their role at signup" on public.user_roles for insert to authenticated with check (auth.uid() = user_id);

create or replace function public.has_role(_user_id uuid, _role public.app_role)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = _user_id and role = _role
  )
$$;

create table public.culture_requests (
  id uuid primary key default gen_random_uuid(),
  culture_id text not null unique,
  requester_id uuid not null,
  patient_id text not null,
  sex text not null,
  age_years integer not null,
  sample_date date not null default current_date,
  admission_date date,
  ward_code text not null,
  specimen text not null,
  suspected_organism text,
  note text,
  status text not null default 'pending',
  result_organism text,
  result_markers smallint not null default 0,
  result_susceptibility text not null default '',
  result_note text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
grant select, insert, update on public.culture_requests to authenticated;
grant all on public.culture_requests to service_role;
alter table public.culture_requests enable row level security;
create policy "Doctors create requests" on public.culture_requests for insert to authenticated with check (auth.uid() = requester_id and public.has_role(auth.uid(), 'doctor'));
create policy "Doctors read their own requests" on public.culture_requests for select to authenticated using (auth.uid() = requester_id or public.has_role(auth.uid(), 'lab'));
create policy "Lab completes requests" on public.culture_requests for update to authenticated using (public.has_role(auth.uid(), 'lab')) with check (public.has_role(auth.uid(), 'lab'));

alter publication supabase_realtime add table public.culture_requests;
-- Evolution API multi-tenant migration. Run once in the Supabase SQL Editor.
create extension if not exists "pgcrypto";

create table if not exists public.hospitals (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'ABC Hospital',
  owner_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.hospital_members (
  hospital_id uuid not null references public.hospitals(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'admin' check (role in ('admin','staff')),
  primary key (hospital_id, user_id)
);

create table if not exists public.evolution_connections (
  id uuid primary key default gen_random_uuid(),
  hospital_id uuid not null unique references public.hospitals(id) on delete cascade,
  server_url text not null,
  instance_name text not null unique,
  api_key_encrypted text not null,
  webhook_secret_hash text not null,
  status text not null default 'disconnected' check (status in ('connected','disconnected','connecting','qr_pending')),
  qr_code text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- All operational data gains an owning hospital. Existing rows may be assigned to
-- a migration hospital first, then moved to the appropriate hospital by an admin.
alter table public.conversations add column if not exists hospital_id uuid references public.hospitals(id) on delete cascade;
alter table public.patients add column if not exists hospital_id uuid references public.hospitals(id) on delete cascade;
alter table public.doctors add column if not exists hospital_id uuid references public.hospitals(id) on delete cascade;
alter table public.appointments add column if not exists hospital_id uuid references public.hospitals(id) on delete cascade;
alter table public.hospital_settings add column if not exists hospital_id uuid references public.hospitals(id) on delete cascade;

alter table public.conversations drop constraint if exists conversations_phone_number_key;
alter table public.patients drop constraint if exists patients_phone_number_key;
create unique index if not exists conversations_hospital_phone_key on public.conversations(hospital_id, phone_number);
create unique index if not exists patients_hospital_phone_key on public.patients(hospital_id, phone_number);
create unique index if not exists settings_hospital_key on public.hospital_settings(hospital_id);

alter table public.hospitals enable row level security;
alter table public.hospital_members enable row level security;
alter table public.evolution_connections enable row level security;

create or replace function public.is_hospital_member(target_hospital_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.hospital_members where hospital_id = target_hospital_id and user_id = auth.uid());
$$;

drop policy if exists "members read hospitals" on public.hospitals;
create policy "members read hospitals" on public.hospitals for select to authenticated using (public.is_hospital_member(id));
drop policy if exists "members read memberships" on public.hospital_members;
create policy "members read memberships" on public.hospital_members for select to authenticated using (user_id = auth.uid() or public.is_hospital_member(hospital_id));
drop policy if exists "members manage evolution connection" on public.evolution_connections;
create policy "members manage evolution connection" on public.evolution_connections for all to authenticated using (public.is_hospital_member(hospital_id)) with check (public.is_hospital_member(hospital_id));
create policy "service role manages hospitals" on public.hospitals for all to service_role using (true) with check (true);
create policy "service role manages hospital members" on public.hospital_members for all to service_role using (true) with check (true);
create policy "service role manages evolution connections" on public.evolution_connections for all to service_role using (true) with check (true);

alter publication supabase_realtime add table public.evolution_connections;

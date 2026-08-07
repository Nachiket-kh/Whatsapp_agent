-- Evolution API WhatsApp provider. Run once in Supabase SQL Editor.
create table if not exists public.evolution_connections (
  id uuid primary key default gen_random_uuid(),
  hospital_id uuid not null unique references public.hospitals(id) on delete cascade,
  server_url_encrypted text not null,
  api_key_encrypted text not null,
  instance_name text not null unique,
  display_phone_number text,
  status text not null default 'disconnected' check (status in ('connected','disconnected','qr_pending')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Earlier CareFlow builds created this table before credentials were encrypted.
-- Keep the migration safe to run against both the old and new schemas.
alter table public.evolution_connections
  add column if not exists server_url_encrypted text,
  add column if not exists api_key_encrypted text,
  add column if not exists instance_name text,
  add column if not exists display_phone_number text,
  add column if not exists status text default 'disconnected',
  add column if not exists last_error text,
  add column if not exists created_at timestamptz default now(),
  add column if not exists updated_at timestamptz default now();

create unique index if not exists evolution_connections_hospital_id_key
  on public.evolution_connections (hospital_id);
create unique index if not exists evolution_connections_instance_name_key
  on public.evolution_connections (instance_name)
  where instance_name is not null;

alter table public.evolution_connections enable row level security;
drop policy if exists "members manage evolution connections" on public.evolution_connections;
create policy "members manage evolution connections" on public.evolution_connections
  for all to authenticated using (public.is_hospital_member(hospital_id)) with check (public.is_hospital_member(hospital_id));
drop policy if exists "service role manages evolution connections" on public.evolution_connections;
create policy "service role manages evolution connections" on public.evolution_connections
  for all to service_role using (true) with check (true);

do $$ begin
  if not exists (
    select 1 from pg_publication p join pg_publication_rel pr on pr.prpubid=p.oid
    join pg_class c on c.oid=pr.prrelid join pg_namespace n on n.oid=c.relnamespace
    where p.pubname='supabase_realtime' and n.nspname='public' and c.relname='evolution_connections'
  ) then alter publication supabase_realtime add table public.evolution_connections; end if;
end $$;

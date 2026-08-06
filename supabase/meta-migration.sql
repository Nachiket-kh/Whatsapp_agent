-- Meta WhatsApp Business Cloud API migration. Run this once in Supabase SQL Editor.
create table if not exists public.meta_connections (
  id uuid primary key default gen_random_uuid(),
  hospital_id uuid not null unique references public.hospitals(id) on delete cascade,
  phone_number_id text not null unique,
  access_token_encrypted text not null,
  verify_token_hash text not null,
  display_phone_number text,
  status text not null default 'connected' check (status in ('connected','disconnected')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- OAuth / Embedded Signup metadata. Safe to run repeatedly on an existing project.
alter table public.meta_connections add column if not exists whatsapp_business_account_id text;
alter table public.meta_connections add column if not exists connection_source text not null default 'manual'
  check (connection_source in ('manual', 'oauth'));

alter table public.meta_connections enable row level security;
drop policy if exists "members manage meta connection" on public.meta_connections;
create policy "members manage meta connection" on public.meta_connections
  for all to authenticated
  using (public.is_hospital_member(hospital_id))
  with check (public.is_hospital_member(hospital_id));
drop policy if exists "service role manages meta connections" on public.meta_connections;
create policy "service role manages meta connections" on public.meta_connections
  for all to service_role using (true) with check (true);

do $$ begin
  if not exists (
    select 1 from pg_publication p join pg_publication_rel pr on pr.prpubid=p.oid
    join pg_class c on c.oid=pr.prrelid join pg_namespace n on n.oid=c.relnamespace
    where p.pubname='supabase_realtime' and n.nspname='public' and c.relname='meta_connections'
  ) then alter publication supabase_realtime add table public.meta_connections; end if;
end $$;

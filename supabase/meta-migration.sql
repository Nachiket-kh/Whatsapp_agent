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

-- Default chat/contact expiry. Appointment records are never deleted by the
-- retention task, so booked patients remain visible to the hospital.
alter table public.hospital_settings add column if not exists chat_retention_hours integer not null default 24;
alter table public.hospital_settings drop constraint if exists hospital_settings_chat_retention_hours_check;
alter table public.hospital_settings add constraint hospital_settings_chat_retention_hours_check
  check (chat_retention_hours between 1 and 720);

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

-- Durable idempotency records for Meta retries. Meta can deliver the same
-- message more than once; the unique provider message id guarantees that an
-- appointment or reply is created only once even during high traffic.
create table if not exists public.whatsapp_webhook_events (
  id uuid primary key default gen_random_uuid(),
  hospital_id uuid not null references public.hospitals(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  provider text not null default 'meta' check (provider = 'meta'),
  provider_message_id text not null,
  status text not null default 'processing' check (status in ('processing', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (provider, provider_message_id)
);

create index if not exists whatsapp_webhook_events_hospital_status_idx
  on public.whatsapp_webhook_events (hospital_id, status, created_at desc);

alter table public.whatsapp_webhook_events enable row level security;
drop policy if exists "members read their webhook events" on public.whatsapp_webhook_events;
create policy "members read their webhook events" on public.whatsapp_webhook_events
  for select to authenticated using (public.is_hospital_member(hospital_id));
drop policy if exists "service role manages webhook events" on public.whatsapp_webhook_events;
create policy "service role manages webhook events" on public.whatsapp_webhook_events
  for all to service_role using (true) with check (true);

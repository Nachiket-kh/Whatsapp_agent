-- Run once in Supabase SQL Editor to enable per-hospital AI provider settings.
create table if not exists public.ai_connections (
  id uuid primary key default gen_random_uuid(),
  hospital_id uuid not null unique references public.hospitals(id) on delete cascade,
  provider text not null check (provider in ('groq', 'openai')),
  api_key_encrypted text not null,
  model text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.ai_connections enable row level security;
drop policy if exists "members manage AI connections" on public.ai_connections;
create policy "members manage AI connections" on public.ai_connections for all to authenticated using (public.is_hospital_member(hospital_id)) with check (public.is_hospital_member(hospital_id));
drop policy if exists "service role manages AI connections" on public.ai_connections;
create policy "service role manages AI connections" on public.ai_connections for all to service_role using (true) with check (true);

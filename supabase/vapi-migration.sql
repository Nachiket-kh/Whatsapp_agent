-- Vapi multi-tenant voice receptionist. Run once in the Supabase SQL Editor.
create table if not exists public.vapi_connections (
  id uuid primary key default gen_random_uuid(), hospital_id uuid not null unique references public.hospitals(id) on delete cascade,
  api_key_encrypted text not null, assistant_id text not null, phone_number_id text, default_language text not null default 'Marathi',
  greeting text, webhook_secret_hash text not null, enabled boolean not null default true, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.vapi_call_logs (
  id uuid primary key default gen_random_uuid(), hospital_id uuid not null references public.hospitals(id) on delete cascade,
  vapi_call_id text not null, caller_phone text, transcript text, duration_seconds integer, booking_status text not null default 'not_booked', status text not null default 'completed', failure_reason text, started_at timestamptz, ended_at timestamptz, created_at timestamptz not null default now(), unique(hospital_id,vapi_call_id)
);
alter table public.vapi_connections enable row level security; alter table public.vapi_call_logs enable row level security;
create policy "members manage vapi connections" on public.vapi_connections for all to authenticated using (public.is_hospital_member(hospital_id)) with check (public.is_hospital_member(hospital_id));
create policy "members read vapi calls" on public.vapi_call_logs for select to authenticated using (public.is_hospital_member(hospital_id));
create policy "service role manages vapi connections" on public.vapi_connections for all to service_role using (true) with check (true);
create policy "service role manages vapi calls" on public.vapi_call_logs for all to service_role using (true) with check (true);
alter publication supabase_realtime add table public.vapi_call_logs;

-- ElevenLabs voice-agent support. Run once in the Supabase SQL Editor.
create table if not exists public.voice_agent_connections (
  id uuid primary key default gen_random_uuid(),
  hospital_id uuid not null unique references public.hospitals(id) on delete cascade,
  elevenlabs_api_key_encrypted text not null,
  agent_id text not null,
  phone_number text,
  webhook_secret_hash text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.voice_call_logs (
  id uuid primary key default gen_random_uuid(),
  hospital_id uuid not null references public.hospitals(id) on delete cascade,
  elevenlabs_conversation_id text not null,
  caller_phone text,
  transcript text,
  status text not null default 'completed',
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  unique (hospital_id, elevenlabs_conversation_id)
);

alter table public.voice_agent_connections enable row level security;
alter table public.voice_call_logs enable row level security;

drop policy if exists "members manage voice agent connection" on public.voice_agent_connections;
create policy "members manage voice agent connection" on public.voice_agent_connections for all to authenticated
  using (public.is_hospital_member(hospital_id)) with check (public.is_hospital_member(hospital_id));
drop policy if exists "members read voice call logs" on public.voice_call_logs;
create policy "members read voice call logs" on public.voice_call_logs for select to authenticated
  using (public.is_hospital_member(hospital_id));
drop policy if exists "service role manages voice connections" on public.voice_agent_connections;
create policy "service role manages voice connections" on public.voice_agent_connections for all to service_role using (true) with check (true);
drop policy if exists "service role manages voice call logs" on public.voice_call_logs;
create policy "service role manages voice call logs" on public.voice_call_logs for all to service_role using (true) with check (true);

alter publication supabase_realtime add table public.voice_call_logs;

-- Run this file in the Supabase SQL editor before using the app.
create extension if not exists "pgcrypto";

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  phone_number text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.patients (
  id uuid primary key default gen_random_uuid(),
  phone_number text not null unique,
  full_name text,
  last_seen timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.doctors (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  department text not null,
  enabled boolean not null default true,
  working_days text[] not null default array['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'],
  start_time time not null default '09:00',
  end_time time not null default '17:00',
  consultation_duration integer not null default 20 check (consultation_duration > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references public.patients(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  doctor_id uuid references public.doctors(id) on delete set null,
  patient_name text not null,
  phone_number text not null,
  doctor_name text,
  department text,
  appointment_date date not null,
  appointment_time time not null,
  reason text,
  status text not null default 'upcoming' check (status in ('upcoming','completed','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.appointment_drafts (
  conversation_id uuid primary key references public.conversations(id) on delete cascade,
  language text not null default 'English',
  stage text not null default 'idle',
  patient_name text,
  doctor_or_department text,
  preferred_date date,
  reason text,
  offered_slots text[],
  updated_at timestamptz not null default now()
);

create table if not exists public.hospital_settings (
  id integer primary key default 1 check (id = 1),
  hospital_name text not null default 'ABC Hospital',
  hospital_logo text,
  departments text[] not null default array['General Medicine','Cardiology','Orthopedics','Pediatrics'],
  opening_time time not null default '09:00',
  closing_time time not null default '17:00',
  slot_duration integer not null default 20,
  chat_retention_hours integer not null default 24 check (chat_retention_hours between 1 and 720),
  emergency_number text,
  whatsapp_number text,
  receptionist_number text,
  updated_at timestamptz not null default now()
);

insert into public.hospital_settings (id) values (1) on conflict (id) do nothing;

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists messages_conversation_created_at_idx
  on public.messages(conversation_id, created_at);
create index if not exists appointments_date_status_idx on public.appointments(appointment_date, status);
create unique index if not exists appointments_active_doctor_slot_idx
  on public.appointments(doctor_id, appointment_date, appointment_time) where status = 'upcoming';

alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.patients enable row level security;
alter table public.doctors enable row level security;
alter table public.appointments enable row level security;
alter table public.appointment_drafts enable row level security;
alter table public.hospital_settings enable row level security;

create policy "service role manages conversations" on public.conversations
  for all to service_role using (true) with check (true);
create policy "authenticated users read conversations" on public.conversations
  for select to authenticated using (true);
create policy "service role manages messages" on public.messages
  for all to service_role using (true) with check (true);
create policy "authenticated users read messages" on public.messages
  for select to authenticated using (true);

create policy "service role manages patients" on public.patients for all to service_role using (true) with check (true);
create policy "service role manages doctors" on public.doctors for all to service_role using (true) with check (true);
create policy "service role manages appointments" on public.appointments for all to service_role using (true) with check (true);
create policy "service role manages appointment drafts" on public.appointment_drafts for all to service_role using (true) with check (true);
create policy "service role manages hospital settings" on public.hospital_settings for all to service_role using (true) with check (true);
create policy "authenticated users manage patients" on public.patients for all to authenticated using (true) with check (true);
create policy "authenticated users manage doctors" on public.doctors for all to authenticated using (true) with check (true);
create policy "authenticated users manage appointments" on public.appointments for all to authenticated using (true) with check (true);
create policy "authenticated users manage hospital settings" on public.hospital_settings for all to authenticated using (true) with check (true);

-- Include both tables in the realtime publication.
alter publication supabase_realtime add table public.conversations;
alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.patients;
alter publication supabase_realtime add table public.doctors;
alter publication supabase_realtime add table public.appointments;

-- Run once in Supabase SQL Editor for existing installations.
alter table public.hospital_settings add column if not exists receptionist_number text;

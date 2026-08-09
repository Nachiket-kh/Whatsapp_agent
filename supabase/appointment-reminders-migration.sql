-- Run once in the Supabase SQL Editor.
-- Prevents duplicate two-hour WhatsApp appointment reminders.
alter table public.appointments
  add column if not exists reminder_sent_at timestamptz;

create index if not exists appointments_reminder_queue_idx
  on public.appointments (status, appointment_date, appointment_time)
  where reminder_sent_at is null and status = 'upcoming';

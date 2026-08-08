import { NextRequest, NextResponse } from "next/server";
import { serviceClient } from "@/lib/hospital";

export type Doctor = { id: string; name: string; department: string; working_days: string[]; start_time: string; end_time: string; consultation_duration: number };

export function requireN8n(request: NextRequest) {
  const secret = process.env.N8N_API_SECRET;
  if (!secret || request.headers.get("x-n8n-secret") !== secret) return NextResponse.json({ error: "Unauthorized n8n request." }, { status: 401 });
  return null;
}

export async function hospitalForChannel(channel: { phoneNumberId?: string; instanceName?: string }) {
  if (channel.instanceName) {
    const { data, error } = await serviceClient().from("evolution_connections").select("hospital_id").eq("instance_name", channel.instanceName).maybeSingle();
    if (error) { console.error("n8n Evolution connection lookup failed", error); throw error; }
    if (!data) throw new Error("No hospital is connected to this Evolution instance.");
    return data.hospital_id as string;
  }
  if (!channel.phoneNumberId) throw new Error("A WhatsApp Phone Number ID or Evolution instance name is required.");
  const { data, error } = await serviceClient().from("meta_connections").select("hospital_id,phone_number_id").eq("phone_number_id", channel.phoneNumberId).maybeSingle();
  if (error) { console.error("n8n Meta connection lookup failed", error); throw error; }
  if (!data) throw new Error("No hospital is connected to this WhatsApp Phone Number ID.");
  return data.hospital_id as string;
}

function indiaParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}
export const todayInIndia = (now = new Date()) => { const date = indiaParts(now); return `${date.year}-${date.month}-${date.day}`; };
export const minutesNowInIndia = (now = new Date()) => { const date = indiaParts(now); return Number(date.hour) * 60 + Number(date.minute); };
export const validDate = (value: string) => /^20\d{2}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && value >= todayInIndia();
export const weekdayForDate = (value: string) => new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
const minutes = (value: string) => { const [hour, minute] = value.slice(0, 5).split(":").map(Number); return hour * 60 + minute; };
const asTime = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
export type SlotBlockReason = "sunday" | "doctor_unavailable" | "hospital_closed";
export function slotBlockReason(doctor: Doctor, date: string, closingTime: string): SlotBlockReason | null {
  const day = weekdayForDate(date);
  // Sunday is a hospital-wide non-booking day for this application, even if a
  // doctor profile was accidentally configured with Sunday availability.
  if (day === "Sunday") return "sunday";
  if (!doctor.working_days.includes(day)) return "doctor_unavailable";
  if (date === todayInIndia() && minutesNowInIndia() >= minutes(closingTime)) return "hospital_closed";
  return null;
}

export async function availableSlots(hospitalId: string, doctor: Doctor, date: string) {
  const db = serviceClient();
  const [{ data: settings, error: settingsError }, { data: existing, error: existingError }] = await Promise.all([
    db.from("hospital_settings").select("opening_time,closing_time,slot_duration").eq("hospital_id", hospitalId).maybeSingle(),
    db.from("appointments").select("appointment_time").eq("hospital_id", hospitalId).eq("doctor_id", doctor.id).eq("appointment_date", date).eq("status", "upcoming"),
  ]);
  if (settingsError) { console.error("n8n hospital settings lookup failed", settingsError); throw settingsError; }
  if (existingError) { console.error("n8n appointment slots lookup failed", existingError); throw existingError; }
  if (slotBlockReason(doctor, date, String(settings?.closing_time ?? doctor.end_time))) return [];
  const start = Math.max(minutes(doctor.start_time), minutes(settings?.opening_time ?? doctor.start_time));
  const end = Math.min(minutes(doctor.end_time), minutes(settings?.closing_time ?? doctor.end_time));
  const duration = doctor.consultation_duration || settings?.slot_duration || 20;
  const booked = new Set((existing ?? []).map((item) => String(item.appointment_time).slice(0, 5)));
  // For today's bookings, never offer a slot that has already started. The
  // same generated slot value is later stored in the appointment, so a patient
  // is never confirmed for a time different from their selected time.
  const currentMinutes = date === todayInIndia() ? minutesNowInIndia() : -1;
  return Array.from({ length: Math.max(0, Math.floor((end - start) / duration)) }, (_, index) => asTime(start + index * duration))
    .filter((slot) => !booked.has(slot) && minutes(slot) > currentMinutes);
}

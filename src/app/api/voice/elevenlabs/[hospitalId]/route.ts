import { NextRequest, NextResponse } from "next/server";
import { secretHash } from "@/lib/crypto";
import { serviceClient } from "@/lib/hospital";

export const runtime = "nodejs";

const minutes = (value: string) => { const [h, m] = value.slice(0, 5).split(":").map(Number); return h * 60 + m; };
const slot = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const validDate = (value: string) => /^20\d{2}-\d{2}-\d{2}$/.test(value) && value >= new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

export async function POST(request: NextRequest, { params }: { params: Promise<{ hospitalId: string }> }) {
  const { hospitalId } = await params;
  try {
    const token = request.nextUrl.searchParams.get("token") ?? request.headers.get("x-voice-agent-secret") ?? "";
    const supabase = serviceClient();
    const { data: connection, error: connectionError } = await supabase.from("voice_agent_connections").select("*").eq("hospital_id", hospitalId).maybeSingle();
    if (connectionError || !connection || !connection.enabled || secretHash(token) !== connection.webhook_secret_hash) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await request.json() as { action?: string; patient_name?: string; phone_number?: string; doctor_id?: string; date?: string; time?: string };
    const action = body.action;
    if (action === "list_doctors") {
      const { data, error } = await supabase.from("doctors").select("id,name,department").eq("hospital_id", hospitalId).eq("enabled", true).order("department").order("name");
      if (error) throw error;
      return NextResponse.json({ doctors: data ?? [] });
    }
    if (action === "available_slots") {
      if (!body.doctor_id || !body.date || !validDate(body.date)) return NextResponse.json({ error: "A valid future date and doctor are required." }, { status: 400 });
      const [{ data: doctor, error: doctorError }, { data: hospital }, { data: booked, error: bookedError }] = await Promise.all([
        supabase.from("doctors").select("id,name,department,working_days,start_time,end_time,consultation_duration").eq("id", body.doctor_id).eq("hospital_id", hospitalId).eq("enabled", true).single(),
        supabase.from("hospital_settings").select("opening_time,closing_time,slot_duration").eq("hospital_id", hospitalId).maybeSingle(),
        supabase.from("appointments").select("appointment_time").eq("hospital_id", hospitalId).eq("doctor_id", body.doctor_id).eq("appointment_date", body.date).eq("status", "upcoming"),
      ]);
      if (doctorError || !doctor || bookedError) throw doctorError ?? bookedError ?? new Error("Doctor unavailable.");
      const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(`${body.date}T12:00:00Z`));
      if (!doctor.working_days.includes(weekday)) return NextResponse.json({ doctor: doctor.name, date: body.date, slots: [], message: `${doctor.name} does not work on ${weekday}.` });
      const start = Math.max(minutes(doctor.start_time), minutes(hospital?.opening_time ?? doctor.start_time));
      const end = Math.min(minutes(doctor.end_time), minutes(hospital?.closing_time ?? doctor.end_time));
      const duration = doctor.consultation_duration || hospital?.slot_duration || 20;
      const busy = new Set((booked ?? []).map((item) => String(item.appointment_time).slice(0, 5)));
      return NextResponse.json({ doctor: doctor.name, date: body.date, slots: Array.from({ length: Math.max(0, Math.floor((end - start) / duration)) }, (_, i) => slot(start + i * duration)).filter((item) => !busy.has(item)).slice(0, 8) });
    }
    if (action === "book_appointment") {
      if (!body.patient_name?.trim() || !body.phone_number?.replace(/\D/g, "") || !body.doctor_id || !body.date || !body.time || !validDate(body.date)) return NextResponse.json({ error: "Patient name, phone, doctor, valid date, and time are required." }, { status: 400 });
      const phone = body.phone_number.replace(/\D/g, "");
      const [{ data: doctor, error: doctorError }, { data: patient, error: patientError }] = await Promise.all([
        supabase.from("doctors").select("id,name,department").eq("id", body.doctor_id).eq("hospital_id", hospitalId).eq("enabled", true).single(),
        supabase.from("patients").upsert({ hospital_id: hospitalId, phone_number: phone, full_name: body.patient_name.trim(), last_seen: new Date().toISOString() }, { onConflict: "hospital_id,phone_number" }).select("id").single(),
      ]);
      if (doctorError || patientError || !doctor || !patient) throw doctorError ?? patientError ?? new Error("Could not prepare appointment.");
      const { data: conflict } = await supabase.from("appointments").select("id").eq("hospital_id", hospitalId).eq("doctor_id", doctor.id).eq("appointment_date", body.date).eq("appointment_time", body.time).eq("status", "upcoming").maybeSingle();
      if (conflict) return NextResponse.json({ error: "That slot has just been booked. Please choose another available time." }, { status: 409 });
      const { data, error } = await supabase.from("appointments").insert({ hospital_id: hospitalId, patient_id: patient.id, patient_name: body.patient_name.trim(), phone_number: phone, doctor_id: doctor.id, doctor_name: doctor.name, department: doctor.department, appointment_date: body.date, appointment_time: body.time }).select().single();
      if (error) throw error;
      return NextResponse.json({ appointment: data, message: `Appointment confirmed with ${doctor.name} on ${body.date} at ${body.time}.` });
    }
    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    console.error("ElevenLabs booking tool failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to complete voice booking." }, { status: 500 });
  }
}

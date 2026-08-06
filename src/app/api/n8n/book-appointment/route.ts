import { NextRequest, NextResponse } from "next/server";
import { availableSlots, Doctor, hospitalForPhoneNumber, requireN8n, validDate } from "@/lib/n8n";
import { serviceClient } from "@/lib/hospital";

export const runtime = "nodejs";
const validName = (value: string) => /^[\p{L}][\p{L}\s.'-]{1,59}$/u.test(value.trim());

export async function POST(request: NextRequest) {
  const denied = requireN8n(request); if (denied) return denied;
  try {
    const body = await request.json() as { phoneNumberId?: string; patientPhone?: string; patientName?: string; doctorId?: string; date?: string; time?: string; reason?: string; conversation?: string };
    const phoneNumberId = body.phoneNumberId?.trim() ?? ""; const patientPhone = body.patientPhone?.replace(/\D/g, "") ?? ""; const name = body.patientName?.trim() ?? ""; const date = body.date?.trim() ?? ""; const time = body.time?.slice(0, 5) ?? "";
    if (!/^\d+$/.test(phoneNumberId) || !/^\d{8,15}$/.test(patientPhone) || !validName(name) || !body.doctorId || !validDate(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return NextResponse.json({ error: "Invalid patient, doctor, date, or time." }, { status: 400 });
    const hospitalId = await hospitalForPhoneNumber(phoneNumberId); const db = serviceClient();
    const { data: doctor, error: doctorError } = await db.from("doctors").select("id,name,department,working_days,start_time,end_time,consultation_duration").eq("hospital_id", hospitalId).eq("id", body.doctorId).eq("enabled", true).maybeSingle();
    if (doctorError) throw doctorError; if (!doctor) return NextResponse.json({ error: "Doctor is unavailable." }, { status: 404 });
    if (!(await availableSlots(hospitalId, doctor as Doctor, date)).includes(time)) return NextResponse.json({ error: "This time slot is no longer available. Ask the patient to choose another slot." }, { status: 409 });
    const now = new Date().toISOString();
    const { data: conversation, error: conversationError } = await db.from("conversations").upsert({ hospital_id: hospitalId, phone_number: patientPhone, updated_at: now }, { onConflict: "hospital_id,phone_number" }).select("id").single();
    if (conversationError || !conversation) throw conversationError ?? new Error("Could not create conversation.");
    if (body.conversation?.trim()) { const { error } = await db.from("messages").insert({ conversation_id: conversation.id, role: "user", content: body.conversation.trim() }); if (error) console.error("n8n inbound message logging failed", error); }
    const { data: patient, error: patientError } = await db.from("patients").upsert({ hospital_id: hospitalId, phone_number: patientPhone, full_name: name, last_seen: now }, { onConflict: "hospital_id,phone_number" }).select("id,full_name").single();
    if (patientError || !patient) throw patientError ?? new Error("Could not create patient.");
    const { data: appointment, error: appointmentError } = await db.from("appointments").insert({ hospital_id: hospitalId, patient_id: patient.id, conversation_id: conversation.id, doctor_id: doctor.id, patient_name: name, phone_number: patientPhone, doctor_name: doctor.name, department: doctor.department, appointment_date: date, appointment_time: time, reason: body.reason?.trim() || null, status: "upcoming" }).select("*").single();
    if (appointmentError?.code === "23505") return NextResponse.json({ error: "This time slot was just booked. Ask the patient to choose another slot." }, { status: 409 });
    if (appointmentError || !appointment) throw appointmentError ?? new Error("Could not create appointment.");
    return NextResponse.json({ ok: true, appointment, confirmation: `Appointment confirmed with ${doctor.name} on ${date} at ${time}.` });
  } catch (error) { console.error("n8n booking failed", error); return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to book appointment." }, { status: 500 }); }
}

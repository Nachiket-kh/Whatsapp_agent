import { NextRequest, NextResponse } from "next/server";
import { decrypt } from "@/lib/crypto";
import { serviceClient } from "@/lib/hospital";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Appointment = { id: string; hospital_id: string; conversation_id: string | null; patient_name: string; phone_number: string; doctor_name: string | null; department: string | null; appointment_date: string; appointment_time: string; reminder_sent_at: string | null };
type Connection = { hospital_id: string; phone_number_id: string; access_token_encrypted: string };

const appointmentMoment = (appointment: Appointment) => new Date(`${appointment.appointment_date}T${appointment.appointment_time.slice(0, 5)}:00+05:30`);
const displayTime = (value: string) => new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" }).format(new Date(`2000-01-01T${value.slice(0, 5)}:00+05:30`));

async function sendReminder(connection: Connection, appointment: Appointment) {
  const body = `Appointment reminder: Hi ${appointment.patient_name}, your appointment${appointment.doctor_name ? ` with ${appointment.doctor_name}` : ""} is at ${displayTime(appointment.appointment_time)} today. Will you be coming?`;
  const response = await fetch(`https://graph.facebook.com/v22.0/${encodeURIComponent(connection.phone_number_id)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${decrypt(connection.access_token_encrypted)}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: appointment.phone_number,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: { buttons: [
          { type: "reply", reply: { id: `reminder:${appointment.id}:yes`, title: "Yes, I am coming" } },
          { type: "reply", reply: { id: `reminder:${appointment.id}:no`, title: "No, cancel" } },
        ] },
      },
    }),
  });
  if (!response.ok) throw new Error(`Meta reminder send failed (${response.status}): ${await response.text()}`);
  return body;
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = serviceClient();
  const now = new Date();
  const earliest = new Date(now.getTime() + 115 * 60_000);
  const latest = new Date(now.getTime() + 125 * 60_000);
  let sent = 0;
  let failed = 0;

  try {
    const { data: rows, error } = await db.from("appointments")
      .select("id,hospital_id,conversation_id,patient_name,phone_number,doctor_name,department,appointment_date,appointment_time,reminder_sent_at")
      .eq("status", "upcoming")
      .is("reminder_sent_at", null)
      .gte("appointment_date", new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(now))
      .limit(500);
    if (error) throw error;

    const due = ((rows ?? []) as Appointment[]).filter((appointment) => {
      const at = appointmentMoment(appointment).getTime();
      return at >= earliest.getTime() && at <= latest.getTime();
    });
    if (!due.length) return NextResponse.json({ ok: true, sent, failed, due: 0 });

    const hospitalIds = [...new Set(due.map((appointment) => appointment.hospital_id))];
    const { data: connections, error: connectionError } = await db.from("meta_connections")
      .select("hospital_id,phone_number_id,access_token_encrypted")
      .in("hospital_id", hospitalIds);
    if (connectionError) throw connectionError;
    const byHospital = new Map((connections ?? []).map((connection) => [connection.hospital_id, connection as Connection]));

    for (const appointment of due) {
      const connection = byHospital.get(appointment.hospital_id);
      if (!connection) { console.error("Appointment reminder skipped: no Meta connection", { appointmentId: appointment.id }); failed++; continue; }
      try {
        const body = await sendReminder(connection, appointment);
        const conversation = appointment.conversation_id
          ? { id: appointment.conversation_id }
          : (await db.from("conversations").upsert({ hospital_id: appointment.hospital_id, phone_number: appointment.phone_number, updated_at: now.toISOString() }, { onConflict: "hospital_id,phone_number" }).select("id").single()).data;
        if (conversation?.id) await db.from("messages").insert({ conversation_id: conversation.id, role: "assistant", content: body });
        const { error: updateError } = await db.from("appointments").update({ reminder_sent_at: now.toISOString() }).eq("id", appointment.id).is("reminder_sent_at", null);
        if (updateError) throw updateError;
        sent++;
      } catch (error) {
        failed++;
        console.error("Appointment reminder failed", { appointmentId: appointment.id, error });
      }
    }
    return NextResponse.json({ ok: true, sent, failed, due: due.length });
  } catch (error) {
    console.error("Appointment reminder cron failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to send appointment reminders." }, { status: 500 });
  }
}

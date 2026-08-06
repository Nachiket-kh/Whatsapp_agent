import { NextRequest, NextResponse } from "next/server";
import { availableSlots, Doctor, hospitalForChannel, requireN8n, validDate } from "@/lib/n8n";
import { serviceClient } from "@/lib/hospital";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const denied = requireN8n(request); if (denied) return denied;
  try {
    const body = await request.json() as { phoneNumberId?: string; instanceName?: string; doctorId?: string; date?: string };
    const phoneNumberId = body.phoneNumberId?.trim() ?? ""; const date = body.date?.trim() ?? "";
    if ((!/^\d+$/.test(phoneNumberId) && !body.instanceName?.trim()) || !body.doctorId || !validDate(date)) return NextResponse.json({ error: "channel, doctorId, and a valid future date (YYYY-MM-DD) are required." }, { status: 400 });
    const hospitalId = await hospitalForChannel({ phoneNumberId, instanceName: body.instanceName?.trim() });
    const { data: doctor, error } = await serviceClient().from("doctors").select("id,name,department,working_days,start_time,end_time,consultation_duration").eq("hospital_id", hospitalId).eq("id", body.doctorId).eq("enabled", true).maybeSingle();
    if (error) throw error;
    if (!doctor) return NextResponse.json({ error: "Doctor is unavailable." }, { status: 404 });
    return NextResponse.json({ doctor: { id: doctor.id, name: doctor.name, department: doctor.department }, date, slots: await availableSlots(hospitalId, doctor as Doctor, date) });
  } catch (error) { console.error("n8n available slots failed", error); return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load slots." }, { status: 500 }); }
}

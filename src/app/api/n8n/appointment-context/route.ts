import { NextRequest, NextResponse } from "next/server";
import { hospitalForChannel, requireN8n } from "@/lib/n8n";
import { serviceClient } from "@/lib/hospital";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const denied = requireN8n(request); if (denied) return denied;
  try {
    const phoneNumberId = request.nextUrl.searchParams.get("phoneNumberId")?.trim(); const instanceName = request.nextUrl.searchParams.get("instanceName")?.trim();
    if ((!phoneNumberId || !/^\d+$/.test(phoneNumberId)) && !instanceName) return NextResponse.json({ error: "phoneNumberId or instanceName is required." }, { status: 400 });
    const hospitalId = await hospitalForChannel({ phoneNumberId, instanceName });
    const db = serviceClient();
    const [{ data: settings, error: settingsError }, { data: doctors, error: doctorsError }, { data: unavailableDoctors, error: unavailableDoctorsError }] = await Promise.all([
      db.from("hospital_settings").select("hospital_name,departments,opening_time,closing_time,slot_duration,emergency_number").eq("hospital_id", hospitalId).maybeSingle(),
      db.from("doctors").select("id,name,department,working_days,start_time,end_time,consultation_duration").eq("hospital_id", hospitalId).eq("enabled", true).order("department").order("name"),
      db.from("doctors").select("name,department").eq("hospital_id", hospitalId).eq("enabled", false).order("department").order("name"),
    ]);
    if (settingsError || doctorsError || unavailableDoctorsError) throw settingsError ?? doctorsError ?? unavailableDoctorsError;
    return NextResponse.json({ hospitalId, hospital: settings, doctors: doctors ?? [], unavailableDoctors: unavailableDoctors ?? [] });
  } catch (error) { console.error("n8n appointment context failed", error); return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load appointment context." }, { status: 500 }); }
}

import { NextRequest, NextResponse } from "next/server";
import { ensureHospital, serviceClient } from "@/lib/hospital";
import { createClient } from "@/lib/supabase/server";

export async function POST(request: NextRequest) {
  try {
    const auth = await createClient();
    const { data: { user } } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const hospitalId = await ensureHospital(user.id);
    const body = await request.json() as Record<string, unknown>;
    const hospital_name = String(body.hospital_name ?? "").trim();
    if (hospital_name.length < 2 || hospital_name.length > 100) return NextResponse.json({ error: "Enter a valid hospital name." }, { status: 400 });
    const departments = Array.isArray(body.departments) ? body.departments.map(String).map((value) => value.trim()).filter(Boolean).slice(0, 30) : [];
    const slot_duration = Math.min(120, Math.max(5, Number(body.slot_duration) || 20));
    const chat_retention_hours = Math.min(720, Math.max(1, Number(body.chat_retention_hours) || 24));
    const values = { hospital_id: hospitalId, hospital_name, departments, opening_time: String(body.opening_time ?? "09:00").slice(0, 5), closing_time: String(body.closing_time ?? "17:00").slice(0, 5), slot_duration, emergency_number: body.emergency_number ? String(body.emergency_number).trim() : null, whatsapp_number: body.whatsapp_number ? String(body.whatsapp_number).trim() : null, chat_retention_hours };
    const db = serviceClient();
    let { data, error } = await db.from("hospital_settings").upsert(values, { onConflict: "hospital_id" }).select("*").single();
    // Allow the core settings to be saved before the optional retention migration is applied.
    if (error && String(error.message).includes("chat_retention_hours")) {
      const { chat_retention_hours: _, ...legacyValues } = values;
      ({ data, error } = await db.from("hospital_settings").upsert(legacyValues, { onConflict: "hospital_id" }).select("*").single());
    }
    if (error) throw error;
    return NextResponse.json({ settings: data });
  } catch (error) {
    console.error("Hospital settings save failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save hospital settings." }, { status: 500 });
  }
}

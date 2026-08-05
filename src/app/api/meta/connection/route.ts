import { NextRequest, NextResponse } from "next/server";
import { encrypt, secretHash } from "@/lib/crypto";
import { ensureHospital, serviceClient } from "@/lib/hospital";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

async function currentHospital() {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) throw new Error("Unauthorized");
  return ensureHospital(user.id);
}

export async function GET() {
  try {
    const hospitalId = await currentHospital();
    const { data, error } = await serviceClient().from("meta_connections").select("phone_number_id,display_phone_number,status,last_error,updated_at").eq("hospital_id", hospitalId).maybeSingle();
    if (error && !["42P01", "PGRST205"].includes(error.code ?? "")) throw error;
    return NextResponse.json({ connection: data ?? null });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load Meta connection." }, { status: 401 }); }
}

export async function POST(request: NextRequest) {
  try {
    const hospitalId = await currentHospital();
    const body = await request.json() as { phoneNumberId?: string; accessToken?: string; verifyToken?: string; displayPhoneNumber?: string };
    const phoneNumberId = body.phoneNumberId?.trim();
    if (!phoneNumberId || !/^\d+$/.test(phoneNumberId) || !body.accessToken?.trim() || !body.verifyToken?.trim()) return NextResponse.json({ error: "Phone Number ID, permanent access token, and verify token are required." }, { status: 400 });
    const { error } = await serviceClient().from("meta_connections").upsert({ hospital_id: hospitalId, phone_number_id: phoneNumberId, access_token_encrypted: encrypt(body.accessToken.trim()), verify_token_hash: secretHash(body.verifyToken.trim()), display_phone_number: body.displayPhoneNumber?.trim() || null, status: "connected", last_error: null, updated_at: new Date().toISOString() }, { onConflict: "hospital_id" });
    if (error) { console.error("Meta connection write failed", error); throw error; }
    return NextResponse.json({ ok: true });
  } catch (error) { console.error("Meta connection setup failed", error); return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save Meta connection." }, { status: 500 }); }
}

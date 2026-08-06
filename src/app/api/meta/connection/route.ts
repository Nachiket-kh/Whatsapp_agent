import { NextRequest, NextResponse } from "next/server";
import { decrypt, encrypt, secretHash } from "@/lib/crypto";
import { ensureHospital, serviceClient } from "@/lib/hospital";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

async function currentHospital() {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) throw new Error("Unauthorized");
  return ensureHospital(user.id);
}

export async function GET(request: NextRequest) {
  try {
    const hospitalId = await currentHospital();
    const { data, error } = await serviceClient().from("meta_connections").select("phone_number_id,display_phone_number,status,last_error,updated_at,access_token_encrypted").eq("hospital_id", hospitalId).maybeSingle();
    if (error && !["42P01", "PGRST205"].includes(error.code ?? "")) throw error;
    if (!data) return NextResponse.json({ connection: null });
    const apiTest = request.nextUrl.searchParams.get("test");
    if (apiTest !== "1") {
      const { access_token_encrypted: _token, ...safeConnection } = data;
      return NextResponse.json({ connection: safeConnection });
    }
    const response = await fetch(`https://graph.facebook.com/v22.0/${encodeURIComponent(data.phone_number_id)}?fields=display_phone_number,verified_name`, { headers: { Authorization: `Bearer ${decrypt(data.access_token_encrypted)}` } });
    if (!response.ok) {
      const detail = await response.text();
      console.error("Meta token test failed", { status: response.status, detail });
      await serviceClient().from("meta_connections").update({ status: "disconnected", last_error: `Meta token test failed (${response.status})`, updated_at: new Date().toISOString() }).eq("hospital_id", hospitalId);
      return NextResponse.json({ error: `Meta rejected the saved token or Phone Number ID (${response.status}).` }, { status: 400 });
    }
    const meta = await response.json() as { display_phone_number?: string; verified_name?: string };
    await serviceClient().from("meta_connections").update({ status: "connected", display_phone_number: meta.display_phone_number ?? data.display_phone_number, last_error: null, updated_at: new Date().toISOString() }).eq("hospital_id", hospitalId);
    return NextResponse.json({ ok: true, verifiedName: meta.verified_name ?? null, displayPhoneNumber: meta.display_phone_number ?? null });
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

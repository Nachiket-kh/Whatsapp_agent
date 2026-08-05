import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { encrypt, secretHash } from "@/lib/crypto";
import { ensureHospital, serviceClient } from "@/lib/hospital";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

async function hospitalForUser() {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) throw new Error("Unauthorized");
  return ensureHospital(user.id);
}

export async function GET() {
  try {
    const hospitalId = await hospitalForUser();
    const { data, error } = await serviceClient().from("voice_agent_connections")
      .select("agent_id,phone_number,enabled,updated_at").eq("hospital_id", hospitalId).maybeSingle();
    if (error) throw error;
    return NextResponse.json({ connection: data, hospitalId });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load voice settings." }, { status: 401 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const hospitalId = await hospitalForUser();
    const body = await request.json() as { apiKey?: string; agentId?: string; phoneNumber?: string; enabled?: boolean };
    if (!body.apiKey?.trim() || !body.agentId?.trim()) return NextResponse.json({ error: "ElevenLabs API key and Agent ID are required." }, { status: 400 });
    const secret = randomBytes(32).toString("base64url");
    const { error } = await serviceClient().from("voice_agent_connections").upsert({
      hospital_id: hospitalId,
      elevenlabs_api_key_encrypted: encrypt(body.apiKey.trim()),
      agent_id: body.agentId.trim(),
      phone_number: body.phoneNumber?.trim() || null,
      enabled: body.enabled !== false,
      webhook_secret_hash: secretHash(secret),
      updated_at: new Date().toISOString(),
    }, { onConflict: "hospital_id" });
    if (error) throw error;
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin;
    return NextResponse.json({ ok: true, toolUrl: `${origin}/api/voice/elevenlabs/${hospitalId}?token=${secret}`, postCallUrl: `${origin}/api/voice/elevenlabs/${hospitalId}/post-call?token=${secret}` });
  } catch (error) {
    console.error("Voice connection setup failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save voice settings." }, { status: 500 });
  }
}

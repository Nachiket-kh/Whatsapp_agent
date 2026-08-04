import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { encrypt, secretHash } from "@/lib/crypto";
import { ensureHospital, serviceClient } from "@/lib/hospital";
import { evolutionRequest, extractQr, normaliseServerUrl, type EvolutionConnection } from "@/lib/evolution";

export const runtime = "nodejs";

async function currentHospital() {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) throw new Error("Unauthorized");
  return ensureHospital(user.id);
}

async function configureWebhook(connection: EvolutionConnection, webhookUrl: string) {
  try {
    await evolutionRequest(connection, `/webhook/set/${encodeURIComponent(connection.instance_name)}`, {
      method: "POST",
      body: JSON.stringify({ enabled: true, url: webhookUrl, webhook_by_events: false, events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE"] }),
    });
  } catch (error) { console.error("Evolution webhook configuration failed", error); }
}

export async function GET() {
  try {
    const hospitalId = await currentHospital();
    const { data, error } = await serviceClient().from("evolution_connections").select("server_url,instance_name,status,qr_code,last_error,updated_at").eq("hospital_id", hospitalId).maybeSingle();
    if (error) throw error;
    return NextResponse.json({ connection: data ?? null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load connection." }, { status: 401 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const hospitalId = await currentHospital();
    const body = await request.json() as { serverUrl?: string; apiKey?: string; instanceName?: string; action?: "connect" | "reconnect" };
    if (!body.serverUrl || !body.apiKey || !body.instanceName) return NextResponse.json({ error: "Server URL, API key, and instance name are required." }, { status: 400 });
    const serverUrl = normaliseServerUrl(body.serverUrl);
    const instanceName = body.instanceName.trim();
    if (!/^[-a-zA-Z0-9_]+$/.test(instanceName)) return NextResponse.json({ error: "Use only letters, numbers, hyphens, and underscores in the instance name." }, { status: 400 });
    const secret = randomBytes(32).toString("base64url");
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin;
    const webhookUrl = `${origin}/api/evolution/webhook/${encodeURIComponent(instanceName)}?token=${secret}`;
    const connection: EvolutionConnection = { server_url: serverUrl, instance_name: instanceName, api_key_encrypted: encrypt(body.apiKey) };
    try {
      await evolutionRequest(connection, "/", { method: "GET" });
    } catch (error) {
      throw new Error(`Cannot reach Evolution API at ${serverUrl}. Use its API root, not the /manager page. ${error instanceof Error ? error.message : ""}`);
    }
    let provider: Record<string, unknown>;
    try {
      provider = await evolutionRequest(connection, "/instance/create", { method: "POST", body: JSON.stringify({ instanceName, integration: "WHATSAPP-BAILEYS", qrcode: true, webhook: { enabled: true, url: webhookUrl, events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE"] } }) });
    } catch (createError) {
      console.warn("Evolution instance create failed; requesting a fresh connection QR", createError);
      provider = await evolutionRequest(connection, `/instance/connect/${encodeURIComponent(instanceName)}`, { method: "GET" });
    }
    await configureWebhook(connection, webhookUrl);
    const qrCode = extractQr(provider);
    const { error: dbError } = await serviceClient().from("evolution_connections").upsert({ hospital_id: hospitalId, server_url: serverUrl, instance_name: instanceName, api_key_encrypted: connection.api_key_encrypted, webhook_secret_hash: secretHash(secret), qr_code: qrCode, status: qrCode ? "qr_pending" : "connecting", last_error: null, updated_at: new Date().toISOString() }, { onConflict: "hospital_id" });
    if (dbError) { console.error("Supabase Evolution connection upsert failed", dbError); throw dbError; }
    return NextResponse.json({ status: qrCode ? "qr_pending" : "connecting", qrCode });
  } catch (error) {
    console.error("Evolution connection setup failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Connection setup failed." }, { status: 500 });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { decrypt, encrypt } from "@/lib/crypto";
import { evolutionRequest, readEvolutionState } from "@/lib/evolution";
import { ensureHospital, serviceClient } from "@/lib/hospital";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

async function currentHospital() {
  const auth = await createClient(); const { data: { user } } = await auth.auth.getUser();
  if (!user) throw new Error("Unauthorized");
  return ensureHospital(user.id);
}

export async function GET() {
  try {
    const hospitalId = await currentHospital();
    const { data, error } = await serviceClient().from("evolution_connections").select("instance_name,display_phone_number,status,last_error,updated_at").eq("hospital_id", hospitalId).maybeSingle();
    if (error && !["42P01", "PGRST205"].includes(error.code ?? "")) throw error;
    return NextResponse.json({ connection: data ?? null });
  } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load Evolution connection." }, { status: 401 }); }
}

export async function POST(request: NextRequest) {
  try {
    const hospitalId = await currentHospital();
    const body = await request.json() as { serverUrl?: string; apiKey?: string; instanceName?: string };
    const serverUrl = body.serverUrl?.trim().replace(/\/+$/, "") ?? ""; const apiKey = body.apiKey?.trim() ?? ""; const instanceName = body.instanceName?.trim() ?? "";
    if (!/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/i.test(serverUrl) || !apiKey || !/^[a-zA-Z0-9_-]{2,100}$/.test(instanceName)) return NextResponse.json({ error: "Enter a valid Evolution server URL, API key, and instance name." }, { status: 400 });
    const encrypted = { server_url_encrypted: encrypt(serverUrl), api_key_encrypted: encrypt(apiKey), instance_name: instanceName };
    const response = await evolutionRequest(encrypted, `instance/connectionState/${encodeURIComponent(instanceName)}`);
    const responseBody = await response.text();
    if (!response.ok) { console.error("Evolution connection test failed", { status: response.status, responseBody }); return NextResponse.json({ error: `Evolution API rejected this connection (${response.status}).` }, { status: 400 }); }
    let statePayload: unknown = {}; try { statePayload = JSON.parse(responseBody); } catch { /* endpoint can return plain text */ }
    const status = readEvolutionState(statePayload);
    const { error } = await serviceClient().from("evolution_connections").upsert({ hospital_id: hospitalId, ...encrypted, status, last_error: null, updated_at: new Date().toISOString() }, { onConflict: "hospital_id" });
    if (error) { console.error("Evolution connection write failed", error); throw error; }
    return NextResponse.json({ ok: true, status });
  } catch (error) { console.error("Evolution connection setup failed", error); return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save Evolution connection." }, { status: 500 }); }
}

export async function PATCH() {
  try {
    const hospitalId = await currentHospital();
    const { data, error } = await serviceClient().from("evolution_connections").select("server_url_encrypted,api_key_encrypted,instance_name").eq("hospital_id", hospitalId).maybeSingle();
    if (error || !data) return NextResponse.json({ error: "Evolution connection not found." }, { status: 404 });
    const response = await evolutionRequest(data, `instance/connectionState/${encodeURIComponent(data.instance_name)}`);
    const text = await response.text(); if (!response.ok) throw new Error(`Evolution API ${response.status}: ${text}`);
    let payload: unknown = {}; try { payload = JSON.parse(text); } catch { /* ignore */ }
    const status = readEvolutionState(payload);
    await serviceClient().from("evolution_connections").update({ status, last_error: null, updated_at: new Date().toISOString() }).eq("hospital_id", hospitalId);
    return NextResponse.json({ ok: true, status });
  } catch (error) { console.error("Evolution status check failed", error); return NextResponse.json({ error: error instanceof Error ? error.message : "Evolution status check failed." }, { status: 502 }); }
}

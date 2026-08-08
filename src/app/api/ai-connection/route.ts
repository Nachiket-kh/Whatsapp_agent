import { NextRequest, NextResponse } from "next/server";
import { encrypt } from "@/lib/crypto";
import { ensureHospital, serviceClient } from "@/lib/hospital";
import { createClient } from "@/lib/supabase/server";

async function hospital() { const auth = await createClient(); const { data: { user } } = await auth.auth.getUser(); if (!user) throw new Error("Unauthorized"); return ensureHospital(user.id); }

export async function GET() {
  try { const hospitalId = await hospital(); const { data, error } = await serviceClient().from("ai_connections").select("provider,model,enabled,updated_at").eq("hospital_id", hospitalId).maybeSingle(); if (error) throw error; return NextResponse.json({ connection: data }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load AI settings." }, { status: 500 }); }
}

export async function POST(request: NextRequest) {
  try {
    const hospitalId = await hospital(); const body = await request.json() as { provider?: string; apiKey?: string; model?: string; enabled?: boolean };
    const provider = body.provider === "openai" ? "openai" : "groq";
    const model = body.model?.trim() || (provider === "openai" ? "gpt-4o-mini" : "llama-3.3-70b-versatile");
    const db = serviceClient(); const { data: current } = await db.from("ai_connections").select("api_key_encrypted").eq("hospital_id", hospitalId).maybeSingle();
    const encrypted = body.apiKey?.trim() ? encrypt(body.apiKey.trim()) : current?.api_key_encrypted;
    if (!encrypted) return NextResponse.json({ error: "Enter an API key for the selected provider." }, { status: 400 });
    const { data, error } = await db.from("ai_connections").upsert({ hospital_id: hospitalId, provider, api_key_encrypted: encrypted, model, enabled: body.enabled !== false, updated_at: new Date().toISOString() }, { onConflict: "hospital_id" }).select("provider,model,enabled,updated_at").single();
    if (error) throw error; return NextResponse.json({ connection: data });
  } catch (error) { console.error("AI connection save failed", error); return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save AI settings." }, { status: 500 }); }
}

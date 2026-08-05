import { NextRequest, NextResponse } from "next/server";
import { secretHash } from "@/lib/crypto";
import { serviceClient } from "@/lib/hospital";

export const runtime = "nodejs";

export async function POST(request: NextRequest, { params }: { params: Promise<{ hospitalId: string }> }) {
  const { hospitalId } = await params;
  try {
    const token = request.nextUrl.searchParams.get("token") ?? "";
    const supabase = serviceClient();
    const { data: connection } = await supabase.from("voice_agent_connections").select("webhook_secret_hash").eq("hospital_id", hospitalId).maybeSingle();
    if (!connection || secretHash(token) !== connection.webhook_secret_hash) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const event = await request.json() as { data?: Record<string, unknown> };
    const data = event.data ?? {};
    const conversationId = String(data.conversation_id ?? data.conversationId ?? "");
    if (!conversationId) return NextResponse.json({ ok: true });
    const transcript = typeof data.transcript === "string" ? data.transcript : JSON.stringify(data.transcript ?? "");
    const { error } = await supabase.from("voice_call_logs").upsert({ hospital_id: hospitalId, elevenlabs_conversation_id: conversationId, caller_phone: String(data.caller_id ?? data.phone_number ?? "") || null, transcript, status: "completed", ended_at: new Date().toISOString() }, { onConflict: "hospital_id,elevenlabs_conversation_id" });
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("ElevenLabs post-call webhook failed", error);
    return NextResponse.json({ error: "Unable to store call." }, { status: 500 });
  }
}

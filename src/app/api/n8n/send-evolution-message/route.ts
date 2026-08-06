import { NextRequest, NextResponse } from "next/server";
import { evolutionRequest } from "@/lib/evolution";
import { requireN8n } from "@/lib/n8n";
import { serviceClient } from "@/lib/hospital";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const denied = requireN8n(request); if (denied) return denied;
  try {
    const body = await request.json() as { instanceName?: string; to?: string; text?: string };
    const instanceName = body.instanceName?.trim() ?? ""; const to = body.to?.replace(/\D/g, "") ?? ""; const text = body.text?.trim() ?? "";
    if (!instanceName || !/^\d{8,15}$/.test(to) || !text) return NextResponse.json({ error: "instanceName, recipient phone number, and text are required." }, { status: 400 });
    const { data: connection, error } = await serviceClient().from("evolution_connections").select("id,hospital_id,server_url_encrypted,api_key_encrypted,instance_name").eq("instance_name", instanceName).maybeSingle();
    if (error) throw error; if (!connection) return NextResponse.json({ error: "Evolution instance is not connected to a hospital." }, { status: 404 });
    const response = await evolutionRequest(connection, `message/sendText/${encodeURIComponent(instanceName)}`, { method: "POST", body: JSON.stringify({ number: to, text }) });
    const responseText = await response.text();
    if (!response.ok) { console.error("Evolution send failed", { status: response.status, responseText }); await serviceClient().from("evolution_connections").update({ status: "disconnected", last_error: `Message send failed (${response.status})`, updated_at: new Date().toISOString() }).eq("id", connection.id); return NextResponse.json({ error: `Evolution API rejected the message (${response.status}).` }, { status: 502 }); }
    const now = new Date().toISOString();
    const db = serviceClient(); const { data: conversation, error: conversationError } = await db.from("conversations").upsert({ hospital_id: connection.hospital_id, phone_number: to, updated_at: now }, { onConflict: "hospital_id,phone_number" }).select("id").single();
    if (conversationError) console.error("Evolution assistant conversation write failed", conversationError);
    if (conversation?.id) { const { error: messageError } = await db.from("messages").insert({ conversation_id: conversation.id, role: "assistant", content: text }); if (messageError) console.error("Evolution assistant message write failed", messageError); }
    await db.from("evolution_connections").update({ status: "connected", last_error: null, updated_at: now }).eq("id", connection.id);
    return NextResponse.json({ ok: true });
  } catch (error) { console.error("n8n Evolution send failed", error); return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to send Evolution message." }, { status: 500 }); }
}

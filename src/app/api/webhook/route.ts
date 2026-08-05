import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { decrypt, secretHash } from "@/lib/crypto";
import { serviceClient } from "@/lib/hospital";

export const runtime = "nodejs";

type MetaMessage = { from?: string; type?: string; text?: { body?: string } };

async function replyWithGemini(text: string) {
  const prompt = await readFile(path.join(process.cwd(), "AGENT_PROMPT.md"), "utf8");
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not configured.");
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent", { method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ systemInstruction: { parts: [{ text: prompt }] }, contents: [{ role: "user", parts: [{ text }] }], generationConfig: { temperature: 0.45, maxOutputTokens: 350 } }) });
  if (!response.ok) throw new Error(`Gemini ${response.status}: ${await response.text()}`);
  const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return payload.candidates?.[0]?.content?.parts?.map((item) => item.text ?? "").join("").trim();
}

async function sendMetaMessage(phoneNumberId: string, encryptedToken: string, to: string, text: string) {
  const response = await fetch(`https://graph.facebook.com/v22.0/${encodeURIComponent(phoneNumberId)}/messages`, { method: "POST", headers: { Authorization: `Bearer ${decrypt(encryptedToken)}`, "Content-Type": "application/json" }, body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }) });
  if (!response.ok) throw new Error(`Meta Cloud API ${response.status}: ${await response.text()}`);
}

export async function GET(request: NextRequest) {
  console.log("Meta WhatsApp webhook GET received");
  const mode = request.nextUrl.searchParams.get("hub.mode");
  const token = request.nextUrl.searchParams.get("hub.verify_token") ?? "";
  const challenge = request.nextUrl.searchParams.get("hub.challenge");
  if (mode !== "subscribe" || !challenge) return NextResponse.json({ error: "Invalid verification request" }, { status: 400 });
  const { data, error } = await serviceClient().from("meta_connections").select("id").eq("verify_token_hash", secretHash(token)).maybeSingle();
  if (error) console.error("Meta webhook verification lookup failed", error);
  if (!data) return NextResponse.json({ error: "Verification token mismatch" }, { status: 403 });
  return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
}

export async function POST(request: NextRequest) {
  console.log("Meta WhatsApp webhook POST received");
  try {
    const payload = await request.json() as { entry?: Array<{ changes?: Array<{ value?: { metadata?: { phone_number_id?: string }; messages?: MetaMessage[] } }> }> };
    const value = payload.entry?.flatMap((entry) => entry.changes ?? []).map((change) => change.value).find((item) => item?.messages?.length);
    const message = value?.messages?.[0];
    const phoneNumberId = value?.metadata?.phone_number_id;
    const text = message?.type === "text" ? message.text?.body?.trim() : "";
    const from = message?.from?.replace(/\D/g, "");
    if (!phoneNumberId || !from || !text) return NextResponse.json({ ok: true });

    const db = serviceClient();
    const { data: connection, error: connectionError } = await db.from("meta_connections").select("*").eq("phone_number_id", phoneNumberId).maybeSingle();
    if (connectionError || !connection) { console.error("Meta connection lookup failed", connectionError); return NextResponse.json({ ok: true }); }
    const now = new Date().toISOString();
    const { data: conversation, error: conversationError } = await db.from("conversations").upsert({ hospital_id: connection.hospital_id, phone_number: from, updated_at: now }, { onConflict: "hospital_id,phone_number" }).select("id").single();
    if (conversationError || !conversation) { console.error("Meta conversation write failed", conversationError); throw conversationError ?? new Error("Conversation write failed"); }
    const { error: incomingError } = await db.from("messages").insert({ conversation_id: conversation.id, role: "user", content: text });
    if (incomingError) { console.error("Meta incoming message write failed", incomingError); throw incomingError; }
    const reply = await replyWithGemini(text);
    if (!reply) throw new Error("Gemini returned an empty reply.");
    const { error: replyError } = await db.from("messages").insert({ conversation_id: conversation.id, role: "assistant", content: reply });
    if (replyError) { console.error("Meta reply message write failed", replyError); throw replyError; }
    await sendMetaMessage(connection.phone_number_id, connection.access_token_encrypted, from, reply);
    const { error: statusError } = await db.from("meta_connections").update({ status: "connected", last_error: null, updated_at: now }).eq("id", connection.id);
    if (statusError) console.error("Meta connection status update failed", statusError);
  } catch (error) { console.error("Meta WhatsApp webhook processing failed", error); }
  return NextResponse.json({ ok: true });
}

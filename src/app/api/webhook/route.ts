import { NextRequest, NextResponse } from "next/server";
import { secretHash } from "@/lib/crypto";
import { serviceClient } from "@/lib/hospital";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Legacy Meta verification endpoint.
 *
 * WhatsApp messages are intentionally handled by the n8n Meta WhatsApp Trigger,
 * not by this application. The app remains the secured source of truth for
 * hospital configuration, chats, availability, and bookings through /api/n8n.
 */
export async function GET(request: NextRequest) {
  console.log("Meta WhatsApp webhook GET received");
  const mode = request.nextUrl.searchParams.get("hub.mode");
  const token = request.nextUrl.searchParams.get("hub.verify_token") ?? "";
  const challenge = request.nextUrl.searchParams.get("hub.challenge");
  if (mode !== "subscribe" || !challenge) {
    return NextResponse.json({ error: "Invalid verification request" }, { status: 400 });
  }

  if (process.env.META_WEBHOOK_VERIFY_TOKEN && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(challenge, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  const { data, error } = await serviceClient().from("meta_connections").select("id").eq("verify_token_hash", secretHash(token)).maybeSingle();
  if (error) console.error("Meta verification lookup failed", error);
  return data
    ? new NextResponse(challenge, { headers: { "Content-Type": "text/plain; charset=utf-8" } })
    : NextResponse.json({ error: "Verification token mismatch" }, { status: 403 });
}

export async function POST() {
  // Meta should use the n8n production webhook URL. Do not run Gemini or send
  // WhatsApp replies from the Next.js app; n8n owns the conversation layer.
  console.log("Legacy Meta webhook POST received; configure Meta to use the n8n production URL.");
  return NextResponse.json({ ok: true, handledBy: "n8n" }, { status: 202 });
}

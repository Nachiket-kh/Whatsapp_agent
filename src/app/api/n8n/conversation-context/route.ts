import { NextRequest, NextResponse } from "next/server";
import { hospitalForChannel, requireN8n } from "@/lib/n8n";
import { serviceClient } from "@/lib/hospital";

export const runtime = "nodejs";

function languageHint(text: string) {
  const value = text.toLowerCase();
  if (/[ऀ-ॿ]/.test(text)) {
    if (/\b(aahe|ahe|mala|krupaya|appointment|aaj|udya|nav|doctor)\b/i.test(value)) return "Marathi";
    return "Hindi or Marathi";
  }
  if (/\b(namaste|kya|mujhe|hai|hain|kripya|kal|aaj)\b/i.test(value)) return "Hindi";
  return "English";
}

export async function POST(request: NextRequest) {
  const denied = requireN8n(request); if (denied) return denied;
  try {
    const body = await request.json() as { phoneNumberId?: string; instanceName?: string; patientPhone?: string; message?: string };
    const phoneNumberId = body.phoneNumberId?.trim() ?? "", instanceName = body.instanceName?.trim() ?? "", patientPhone = body.patientPhone?.replace(/\D/g, "") ?? "", message = body.message?.trim() ?? "";
    if ((!/^\d+$/.test(phoneNumberId) && !instanceName) || !/^\d{8,15}$/.test(patientPhone) || !message) return NextResponse.json({ error: "A valid channel, patient phone, and message are required." }, { status: 400 });
    const hospitalId = await hospitalForChannel({ phoneNumberId, instanceName }); const db = serviceClient(); const now = new Date().toISOString();
    const { data: conversation, error: conversationError } = await db.from("conversations").upsert({ hospital_id: hospitalId, phone_number: patientPhone, updated_at: now }, { onConflict: "hospital_id,phone_number" }).select("id,phone_number,updated_at").single();
    if (conversationError || !conversation) throw conversationError ?? new Error("Could not create patient conversation.");
    const { error: messageError } = await db.from("messages").insert({ conversation_id: conversation.id, role: "user", content: message }); if (messageError) throw messageError;
    const { data: messages, error: historyError } = await db.from("messages").select("role,content,created_at").eq("conversation_id", conversation.id).order("created_at", { ascending: false }).limit(12); if (historyError) throw historyError;
    const history = (messages ?? []).reverse().map((item) => `${item.role === "assistant" ? "Receptionist" : "Patient"}: ${item.content}`).join("\n");
    return NextResponse.json({
      hospitalId,
      conversationId: conversation.id,
      patientPhone,
      languageHint: languageHint(message),
      history,
    });
  } catch (error) {
    console.error("n8n conversation context failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save the patient conversation." }, { status: 500 });
  }
}

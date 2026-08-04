import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { secretHash } from "@/lib/crypto";
import { evolutionRequest, type EvolutionConnection } from "@/lib/evolution";
import { serviceClient } from "@/lib/hospital";

export const runtime = "nodejs";

type Draft = { language: "English" | "Hindi" | "Marathi"; stage: string; patient_name: string | null; doctor_or_department: string | null; preferred_date: string | null; offered_slots: string[] | null };
const words = {
  English: { welcome: "Hello 👋 Welcome to ABC Hospital. May I know your name?", doctor: "Which doctor or department would you like to visit?", date: "What date would you prefer? Please reply in YYYY-MM-DD format.", slots: "Available timings are:\n", choose: "Please reply with your preferred time.", confirmed: "Your appointment is confirmed.", unavailable: "Sorry, that time is unavailable. Available timings are:\n" },
  Hindi: { welcome: "नमस्ते 👋 ABC Hospital में आपका स्वागत है। कृपया अपना नाम बताएं?", doctor: "आप किस डॉक्टर या विभाग में जाना चाहते हैं?", date: "आप कौन-सी तारीख पसंद करेंगे? कृपया YYYY-MM-DD में बताएं।", slots: "उपलब्ध समय हैं:\n", choose: "कृपया अपना पसंदीदा समय बताएं।", confirmed: "आपकी अपॉइंटमेंट कन्फर्म हो गई है।", unavailable: "माफ़ कीजिए, यह समय उपलब्ध नहीं है। उपलब्ध समय हैं:\n" },
  Marathi: { welcome: "नमस्कार 👋 ABC Hospital मध्ये आपले स्वागत आहे. कृपया आपले नाव सांगा?", doctor: "आपल्याला कोणत्या डॉक्टरांना किंवा विभागाला भेटायचे आहे?", date: "आपल्याला कोणती तारीख हवी आहे? कृपया YYYY-MM-DD मध्ये सांगा.", slots: "उपलब्ध वेळा आहेत:\n", choose: "कृपया पसंतीची वेळ सांगा.", confirmed: "आपली अपॉइंटमेंट निश्चित झाली आहे.", unavailable: "माफ करा, ही वेळ उपलब्ध नाही. उपलब्ध वेळा आहेत:\n" },
};
type Language = keyof typeof words;
const languageOf = (text: string): Language => /ळ|मध्ये|आहे/.test(text) ? "Marathi" : /[\u0900-\u097F]/.test(text) ? "Hindi" : "English";
const dateOf = (text: string) => text.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1] ?? null;
const timeOf = (text: string) => { const m = text.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)?\b/i); if (!m) return null; let h = +m[1]; if (m[3]?.toUpperCase() === "PM" && h < 12) h += 12; if (m[3]?.toUpperCase() === "AM" && h === 12) h = 0; return `${String(h).padStart(2, "0")}:${m[2]}`; };
const display = (slot: string) => { const [h, m] = slot.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`; };
const listSlots = (prefix: string, slots: string[], suffix: string) => `${prefix}${slots.map((slot) => `• ${display(slot)}`).join("\n")}\n${suffix}`;

function messageFrom(payload: Record<string, unknown>) {
  const data = payload.data as Record<string, unknown> | undefined;
  const key = data?.key as Record<string, unknown> | undefined;
  const message = data?.message as Record<string, unknown> | undefined;
  if (!data || key?.fromMe === true) return null;
  const raw = String(key?.remoteJid ?? "");
  const phone = raw.split("@")[0].replace(/\D/g, "");
  const extended = message?.extendedTextMessage as Record<string, unknown> | undefined;
  const button = message?.buttonsResponseMessage as Record<string, unknown> | undefined;
  const text = String(message?.conversation ?? extended?.text ?? button?.selectedDisplayText ?? "").trim();
  return phone && text ? { phone, text } : null;
}

async function sendWithRetry(connection: EvolutionConnection, phone: string, text: string) {
  let failure: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { await evolutionRequest(connection, `/message/sendText/${encodeURIComponent(connection.instance_name)}`, { method: "POST", body: JSON.stringify({ number: phone, text }) }); return; }
    catch (error) { failure = error; console.error("Evolution message send failed", { attempt: attempt + 1, error }); await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** attempt)); }
  }
  throw failure instanceof Error ? failure : new Error("Unable to send Evolution message.");
}

async function generalReply(text: string) {
  const prompt = await readFile(path.join(process.cwd(), "AGENT_PROMPT.md"), "utf8");
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not configured.");
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent", { method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ systemInstruction: { parts: [{ text: prompt }] }, contents: [{ role: "user", parts: [{ text }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 350 } }) });
  if (!response.ok) throw new Error(`Gemini ${response.status}: ${await response.text()}`);
  const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ instance: string }> }) {
  const { instance } = await params;
  console.log("Evolution webhook POST received", { instance });
  try {
    const token = request.nextUrl.searchParams.get("token");
    const payload = await request.json() as Record<string, unknown>;
    const supabase = serviceClient();
    const { data: savedConnection, error: connectionError } = await supabase.from("evolution_connections").select("*").eq("instance_name", instance).maybeSingle();
    if (connectionError || !savedConnection || !token || secretHash(token) !== savedConnection.webhook_secret_hash) { console.error("Evolution webhook authentication failed", { instance, connectionError }); return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
    const event = String(payload.event ?? "");
    if (event.includes("CONNECTION") || event.includes("QRCODE")) {
      const data = payload.data as Record<string, unknown> | undefined;
      const state = String(data?.state ?? data?.status ?? "").toLowerCase();
      const qr = String(data?.qrcode ?? data?.base64 ?? "") || null;
      const status = state === "open" || state === "connected" ? "connected" : qr ? "qr_pending" : "disconnected";
      const { error } = await supabase.from("evolution_connections").update({ status, qr_code: qr, updated_at: new Date().toISOString() }).eq("id", savedConnection.id);
      if (error) console.error("Evolution connection status update failed", error);
      return NextResponse.json({ ok: true });
    }
    if (!event.includes("MESSAGES_UPSERT")) return NextResponse.json({ ok: true });
    const incoming = messageFrom(payload);
    if (!incoming) return NextResponse.json({ ok: true });
    const now = new Date().toISOString();
    const hospitalId = savedConnection.hospital_id as string;
    const connection: EvolutionConnection = { server_url: savedConnection.server_url, instance_name: savedConnection.instance_name, api_key_encrypted: savedConnection.api_key_encrypted };
    const { data: conversation, error: conversationError } = await supabase.from("conversations").upsert({ hospital_id: hospitalId, phone_number: incoming.phone, updated_at: now }, { onConflict: "hospital_id,phone_number" }).select("id").single();
    if (conversationError || !conversation) throw conversationError ?? new Error("Conversation write failed.");
    const { error: messageError } = await supabase.from("messages").insert({ conversation_id: conversation.id, role: "user", content: incoming.text });
    if (messageError) throw messageError;
    const { data: draft } = await supabase.from("appointment_drafts").select("*").eq("conversation_id", conversation.id).maybeSingle();
    let reply: string | undefined; const state = draft as Draft | null;
    const intent = /appointment|book|doctor|hospital|अपॉइंटमेंट|बुक|डॉक्टर|भेट/i.test(incoming.text);
    if (!state && intent) { const language = languageOf(incoming.text); await supabase.from("appointment_drafts").upsert({ conversation_id: conversation.id, language, stage: "name" }); reply = words[language].welcome; }
    else if (state?.stage === "name") { await supabase.from("patients").upsert({ hospital_id: hospitalId, phone_number: incoming.phone, full_name: incoming.text, last_seen: now }, { onConflict: "hospital_id,phone_number" }); await supabase.from("appointment_drafts").update({ patient_name: incoming.text, stage: "doctor", updated_at: now }).eq("conversation_id", conversation.id); reply = words[state.language].doctor; }
    else if (state?.stage === "doctor") { const { data: doctors } = await supabase.from("doctors").select("id,name,department").eq("hospital_id", hospitalId).eq("enabled", true); const search = incoming.text.toLowerCase(); const doctor = doctors?.find((item) => item.name.toLowerCase().includes(search) || item.department.toLowerCase().includes(search) || search.includes(item.name.toLowerCase()) || search.includes(item.department.toLowerCase())); if (!doctor) reply = words[state.language].doctor; else { await supabase.from("appointment_drafts").update({ doctor_or_department: doctor.id, stage: "date", updated_at: now }).eq("conversation_id", conversation.id); reply = words[state.language].date; } }
    else if (state?.stage === "date") { const date = dateOf(incoming.text); if (!date) reply = words[state.language].date; else { const { data: doctor } = await supabase.from("doctors").select("*").eq("id", state.doctor_or_department!).eq("hospital_id", hospitalId).single(); const { data: booked } = await supabase.from("appointments").select("appointment_time").eq("hospital_id", hospitalId).eq("doctor_id", doctor?.id).eq("appointment_date", date).eq("status", "upcoming"); const busy = new Set((booked ?? []).map((item) => String(item.appointment_time).slice(0, 5))); const start = Number(String(doctor?.start_time).slice(0, 2)) * 60 + Number(String(doctor?.start_time).slice(3, 5)); const end = Number(String(doctor?.end_time).slice(0, 2)) * 60 + Number(String(doctor?.end_time).slice(3, 5)); const slots = Array.from({ length: Math.max(0, Math.floor((end - start) / Number(doctor?.consultation_duration))) }, (_, i) => { const value = start + i * Number(doctor?.consultation_duration); return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`; }).filter((slot) => !busy.has(slot)).slice(0, 3); if (!slots.length) reply = "No slots are available for this date. Please choose another date."; else { await supabase.from("appointment_drafts").update({ preferred_date: date, offered_slots: slots, stage: "time", updated_at: now }).eq("conversation_id", conversation.id); reply = listSlots(words[state.language].slots, slots, words[state.language].choose); } } }
    else if (state?.stage === "time") { const selected = timeOf(incoming.text); if (!selected || !state.offered_slots?.includes(selected)) reply = listSlots(words[state.language].unavailable, state.offered_slots ?? [], words[state.language].choose); else { const { data: patient } = await supabase.from("patients").select("id,full_name").eq("hospital_id", hospitalId).eq("phone_number", incoming.phone).single(); const { data: doctor } = await supabase.from("doctors").select("id,name,department").eq("hospital_id", hospitalId).eq("id", state.doctor_or_department!).single(); const { error } = await supabase.from("appointments").insert({ hospital_id: hospitalId, patient_id: patient?.id, conversation_id: conversation.id, doctor_id: doctor?.id, patient_name: state.patient_name ?? patient?.full_name ?? "Patient", phone_number: incoming.phone, doctor_name: doctor?.name, department: doctor?.department, appointment_date: state.preferred_date, appointment_time: selected }); if (error) reply = listSlots(words[state.language].unavailable, state.offered_slots ?? [], words[state.language].choose); else { await supabase.from("appointment_drafts").delete().eq("conversation_id", conversation.id); reply = `${words[state.language].confirmed}\n${doctor?.name} • ${state.preferred_date} • ${display(selected)}`; } } }
    if (!reply) reply = await generalReply(incoming.text);
    if (!reply) throw new Error("AI returned an empty reply.");
    const { error: replyError } = await supabase.from("messages").insert({ conversation_id: conversation.id, role: "assistant", content: reply });
    if (replyError) throw replyError;
    await sendWithRetry(connection, incoming.phone, reply);
    await supabase.from("evolution_connections").update({ status: "connected", last_error: null, updated_at: now }).eq("id", savedConnection.id);
    return NextResponse.json({ ok: true });
  } catch (error) { console.error("Evolution webhook processing failed", error); return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 }); }
}

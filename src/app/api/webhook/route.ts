import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { decrypt, secretHash } from "@/lib/crypto";
import { serviceClient } from "@/lib/hospital";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type MetaMessage = { id?: string; from?: string; type?: string; text?: { body?: string } };
type Lang = "English" | "Hindi" | "Marathi";
type Draft = { language: Lang; stage: string; patient_name: string | null; doctor_or_department: string | null; preferred_date: string | null; offered_slots: string[] | null };
type Doctor = { id: string; name: string; department: string; working_days: string[]; start_time: string; end_time: string; consultation_duration: number };

const languageMenu = "Welcome to ABC Hospital. Please choose your language:\n1. English\n2. Hindi\n3. Marathi\n\nReply 1, 2, or 3.";
const dateMenu = "Choose your preferred date:\n1. Today\n2. Tomorrow\n3. Custom date (reply with YYYY-MM-DD)";
const message = (language: Lang, key: "name" | "doctor" | "slot" | "confirm" | "booked") => ({
  English: { name: "May I have the patient's full name?", doctor: "Please choose a doctor or department.", slot: "Please choose one available time slot.", confirm: "Please confirm: reply 1 for Yes or 2 to change the time.", booked: "Your appointment is confirmed." },
  Hindi: { name: "कृपया मरीज का पूरा नाम बताएं।", doctor: "कृपया डॉक्टर या विभाग चुनें।", slot: "कृपया उपलब्ध समय चुनें।", confirm: "पुष्टि के लिए 1 दबाएं, समय बदलने के लिए 2 दबाएं।", booked: "आपकी अपॉइंटमेंट कन्फर्म हो गई है।" },
  Marathi: { name: "कृपया रुग्णाचे पूर्ण नाव सांगा.", doctor: "कृपया डॉक्टर किंवा विभाग निवडा.", slot: "कृपया उपलब्ध वेळ निवडा.", confirm: "पुष्टीसाठी 1 द्या, वेळ बदलण्यासाठी 2 द्या.", booked: "तुमची अपॉइंटमेंट निश्चित झाली आहे." },
}[language][key]);

const clean = (value: string) => value.trim();
const validName = (value: string) => /^[\p{L}][\p{L}\s.'-]{1,59}$/u.test(clean(value));
const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const tomorrow = () => { const date = new Date(`${today()}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + 1); return date.toISOString().slice(0, 10); };
const validDate = (value: string) => /^20\d{2}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && value >= today();
const weekday = (value: string) => new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`));
const minute = (value: string) => { const [h, m] = value.slice(0, 5).split(":").map(Number); return h * 60 + m; };
const time = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const displayTime = (value: string) => { const [h, m] = value.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`; };
const selectedLanguage = (value: string): Lang | null => ({ "1": "English", english: "English", en: "English", "2": "Hindi", hindi: "Hindi", hi: "Hindi", "3": "Marathi", marathi: "Marathi", mr: "Marathi" }[clean(value).toLowerCase()] as Lang | undefined) ?? null;
const options = (items: string[], tail: string) => `${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\n${tail}`;
const restart = /^(restart|start over|new appointment|book again|cancel|stop)$/i;

async function generalReply(text: string) {
  const prompt = await readFile(path.join(process.cwd(), "AGENT_PROMPT.md"), "utf8");
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not configured.");
  const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent", { method: "POST", headers: { "x-goog-api-key": key, "Content-Type": "application/json" }, body: JSON.stringify({ systemInstruction: { parts: [{ text: `${prompt}\nIf the user wants an appointment, ask them to type: book appointment.` }] }, contents: [{ role: "user", parts: [{ text }] }], generationConfig: { temperature: .35, maxOutputTokens: 250 } }) });
  if (!response.ok) throw new Error(`Gemini ${response.status}: ${await response.text()}`);
  const data = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
}

async function sendMetaMessage(phoneNumberId: string, encryptedToken: string, to: string, text: string) {
  const response = await fetch(`https://graph.facebook.com/v22.0/${encodeURIComponent(phoneNumberId)}/messages`, { method: "POST", headers: { Authorization: `Bearer ${decrypt(encryptedToken)}`, "Content-Type": "application/json" }, body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }) });
  if (!response.ok) throw new Error(`Meta Cloud API ${response.status}: ${await response.text()}`);
}

async function availableSlots(db: ReturnType<typeof serviceClient>, hospitalId: string, doctor: Doctor, date: string) {
  if (!doctor.working_days.includes(weekday(date))) return [];
  const [{ data: settings }, { data: existing, error }] = await Promise.all([
    db.from("hospital_settings").select("opening_time,closing_time,slot_duration").eq("hospital_id", hospitalId).maybeSingle(),
    db.from("appointments").select("appointment_time").eq("hospital_id", hospitalId).eq("doctor_id", doctor.id).eq("appointment_date", date).eq("status", "upcoming"),
  ]);
  if (error) throw error;
  const start = Math.max(minute(doctor.start_time), minute(settings?.opening_time ?? doctor.start_time));
  const end = Math.min(minute(doctor.end_time), minute(settings?.closing_time ?? doctor.end_time));
  const duration = doctor.consultation_duration || settings?.slot_duration || 20;
  const booked = new Set((existing ?? []).map((item) => String(item.appointment_time).slice(0, 5)));
  return Array.from({ length: Math.max(0, Math.floor((end - start) / duration)) }, (_, index) => time(start + index * duration)).filter((slot) => !booked.has(slot)).slice(0, 6);
}

export async function GET(request: NextRequest) {
  console.log("Meta WhatsApp webhook GET received");
  const mode = request.nextUrl.searchParams.get("hub.mode"); const token = request.nextUrl.searchParams.get("hub.verify_token") ?? ""; const challenge = request.nextUrl.searchParams.get("hub.challenge");
  if (mode !== "subscribe" || !challenge) return NextResponse.json({ error: "Invalid verification request" }, { status: 400 });
  // Meta verifies one callback URL at the app level. Prefer the Vercel environment
  // token, while retaining existing hospital-specific manual connections as fallback.
  if (process.env.META_WEBHOOK_VERIFY_TOKEN && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    return new NextResponse(challenge, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const { data, error } = await serviceClient().from("meta_connections").select("id").eq("verify_token_hash", secretHash(token)).maybeSingle();
  if (error) console.error("Meta verification lookup failed", error);
  return data ? new NextResponse(challenge, { headers: { "Content-Type": "text/plain" } }) : NextResponse.json({ error: "Verification token mismatch" }, { status: 403 });
}

export async function POST(request: NextRequest) {
  console.log("Meta WhatsApp webhook POST received");
  try {
    const payload = await request.json() as { entry?: Array<{ changes?: Array<{ value?: { metadata?: { phone_number_id?: string }; messages?: MetaMessage[] } }> }> };
    const value = payload.entry?.flatMap((entry) => entry.changes ?? []).map((change) => change.value).find((item) => item?.messages?.length);
    const incoming = value?.messages?.[0]; const phoneNumberId = value?.metadata?.phone_number_id; const from = incoming?.from?.replace(/\D/g, ""); const text = incoming?.type === "text" ? clean(incoming.text?.body ?? "") : "";
    if (!phoneNumberId || !from || !text) return NextResponse.json({ ok: true });
    const db = serviceClient(); const { data: connection, error: connectionError } = await db.from("meta_connections").select("*").eq("phone_number_id", phoneNumberId).maybeSingle();
    if (connectionError || !connection) { console.error("Meta connection lookup failed", connectionError); return NextResponse.json({ ok: true }); }
    const now = new Date().toISOString(); const hospitalId = connection.hospital_id as string;
    const { data: conversation, error: conversationError } = await db.from("conversations").upsert({ hospital_id: hospitalId, phone_number: from, updated_at: now }, { onConflict: "hospital_id,phone_number" }).select("id").single();
    if (conversationError || !conversation) throw conversationError ?? new Error("Conversation write failed");
    const { error: inputError } = await db.from("messages").insert({ conversation_id: conversation.id, role: "user", content: text }); if (inputError) throw inputError;
    const { data: draftRow } = await db.from("appointment_drafts").select("*").eq("conversation_id", conversation.id).maybeSingle(); const draft = draftRow as Draft | null;
    let reply = "";
    if (restart.test(text)) { await db.from("appointment_drafts").upsert({ conversation_id: conversation.id, language: "English", stage: "language", patient_name: null, doctor_or_department: null, preferred_date: null, offered_slots: null, updated_at: now }); reply = languageMenu; }
    else if (!draft && /\b(book|appointment|doctor|visit)\b/i.test(text)) { await db.from("appointment_drafts").upsert({ conversation_id: conversation.id, language: "English", stage: "language", updated_at: now }); reply = languageMenu; }
    else if (!draft) reply = await generalReply(text) ?? "I can help with hospital information or appointment booking. Type: book appointment";
    else if (draft.stage === "language") { const language = selectedLanguage(text); if (!language) reply = `Please select a language.\n\n${languageMenu}`; else { await db.from("appointment_drafts").update({ language, stage: "name", updated_at: now }).eq("conversation_id", conversation.id); reply = message(language, "name"); } }
    else if (draft.stage === "name") { if (!validName(text)) reply = `${message(draft.language, "name")}\n\nPlease use letters only, for example: Riya Patil.`; else { await db.from("patients").upsert({ hospital_id: hospitalId, phone_number: from, full_name: text, last_seen: now }, { onConflict: "hospital_id,phone_number" }); const { data: doctors } = await db.from("doctors").select("id,name,department").eq("hospital_id", hospitalId).eq("enabled", true).order("department"); await db.from("appointment_drafts").update({ patient_name: text, stage: "doctor", updated_at: now }).eq("conversation_id", conversation.id); reply = doctors?.length ? options(doctors.map((doctor) => `${doctor.name} — ${doctor.department}`), "Reply with 1, 2, 3, or type the doctor/department name.") : "No doctors are currently configured. Please contact the hospital."; } }
    else if (draft.stage === "doctor") { const { data: doctors } = await db.from("doctors").select("id,name,department,working_days,start_time,end_time,consultation_duration").eq("hospital_id", hospitalId).eq("enabled", true).order("department"); const list = (doctors ?? []) as Doctor[]; const choice = Number(text); const doctor = Number.isInteger(choice) && choice > 0 ? list[choice - 1] : list.find((item) => `${item.name} ${item.department}`.toLowerCase().includes(text.toLowerCase())); if (!doctor) reply = options(list.map((item) => `${item.name} — ${item.department}`), "Please reply with a valid doctor number or name."); else { await db.from("appointment_drafts").update({ doctor_or_department: doctor.id, stage: "date", updated_at: now }).eq("conversation_id", conversation.id); reply = `${doctor.name}, ${doctor.department}\n\n${dateMenu}`; } }
    else if (draft.stage === "date") { const date = text === "1" ? today() : text === "2" ? tomorrow() : validDate(text) ? text : null; if (!date) reply = `${dateMenu}\n\nFor a custom date, reply with YYYY-MM-DD.`; else { const { data: doctor } = await db.from("doctors").select("id,name,department,working_days,start_time,end_time,consultation_duration").eq("hospital_id", hospitalId).eq("id", draft.doctor_or_department!).single(); const slots = doctor ? await availableSlots(db, hospitalId, doctor as Doctor, date) : []; if (!slots.length) reply = `There are no available slots on ${date}.\n\n${dateMenu}`; else { await db.from("appointment_drafts").update({ preferred_date: date, offered_slots: slots, stage: "time", updated_at: now }).eq("conversation_id", conversation.id); reply = options(slots.map(displayTime), `${message(draft.language, "slot")} Reply 1, 2, 3…`); } } }
    else if (draft.stage === "time") { const choice = Number(text); const slot = Number.isInteger(choice) && choice > 0 ? draft.offered_slots?.[choice - 1] : null; if (!slot) reply = options((draft.offered_slots ?? []).map(displayTime), "Please reply with a valid time-slot number."); else { await db.from("appointment_drafts").update({ offered_slots: [slot], stage: "confirm", updated_at: now }).eq("conversation_id", conversation.id); reply = `Appointment summary:\n${draft.patient_name}\n${draft.preferred_date} at ${displayTime(slot)}\n\n${message(draft.language, "confirm")}`; } }
    else if (draft.stage === "confirm") { if (text === "2") { await db.from("appointment_drafts").update({ stage: "date", offered_slots: null, updated_at: now }).eq("conversation_id", conversation.id); reply = dateMenu; } else if (text === "1" || /^yes$/i.test(text)) { const slot = draft.offered_slots?.[0]; const { data: doctor } = await db.from("doctors").select("id,name,department").eq("hospital_id", hospitalId).eq("id", draft.doctor_or_department!).single(); const { data: patient } = await db.from("patients").select("id,full_name").eq("hospital_id", hospitalId).eq("phone_number", from).single(); if (!slot || !doctor || !patient) throw new Error("Booking details are incomplete."); const { error } = await db.from("appointments").insert({ hospital_id: hospitalId, patient_id: patient.id, conversation_id: conversation.id, doctor_id: doctor.id, patient_name: draft.patient_name ?? patient.full_name ?? "Patient", phone_number: from, doctor_name: doctor.name, department: doctor.department, appointment_date: draft.preferred_date, appointment_time: slot, status: "upcoming" }); if (error?.code === "23505") reply = "That slot was just booked. Please choose another date."; else if (error) throw error; else { await db.from("appointment_drafts").delete().eq("conversation_id", conversation.id); reply = `${message(draft.language, "booked")}\n${doctor.name} · ${draft.preferred_date} · ${displayTime(slot)}\n\nFor another booking, type: new appointment`; } } else reply = message(draft.language, "confirm"); }
    else { await db.from("appointment_drafts").delete().eq("conversation_id", conversation.id); reply = "Let’s start again.\n\n" + languageMenu; }
    const { error: replyError } = await db.from("messages").insert({ conversation_id: conversation.id, role: "assistant", content: reply }); if (replyError) throw replyError;
    await sendMetaMessage(connection.phone_number_id, connection.access_token_encrypted, from, reply);
    await db.from("meta_connections").update({ status: "connected", last_error: null, updated_at: now }).eq("id", connection.id);
  } catch (error) { console.error("Meta WhatsApp webhook processing failed", error); }
  return NextResponse.json({ ok: true });
}

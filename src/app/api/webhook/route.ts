import { NextRequest, NextResponse } from "next/server";
import { decrypt, secretHash } from "@/lib/crypto";
import { availableSlots, Doctor, todayInIndia, validDate } from "@/lib/n8n";
import { serviceClient } from "@/lib/hospital";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Language = "English" | "Hindi" | "Marathi";
type Draft = { language: Language; stage: string; patient_name: string | null; doctor_or_department: string | null; preferred_date: string | null; reason: string | null; offered_slots: string[] | null };
type MetaMessage = { from?: string; type?: string; text?: { body?: string } };

const languageMenu = "Welcome to CareFlow Hospital Reception. Please choose your language:\n1. Marathi\n2. Hindi\n3. English";
const intentMenu = (language: Language) => language === "Marathi"
  ? "मी कशी मदत करू?\n1. Appointment book करा\n2. Doctors / departments\n3. Hospital timings"
  : language === "Hindi"
    ? "मैं कैसे मदद कर सकती हूँ?\n1. Appointment book करें\n2. Doctors / departments\n3. Hospital timings"
    : "How can I help?\n1. Book an appointment\n2. Doctors / departments\n3. Hospital timings";
const messages = {
  English: { name: "Please share the patient's full name.", reason: "What is the reason for the visit?", doctor: "Please choose a doctor or department.", date: "Choose your date:\n1. Today\n2. Tomorrow\n3. Custom date (YYYY-MM-DD)", slot: "Choose an available time slot. Reply with 1, 2, or 3.", confirm: "Reply YES to confirm this appointment, or NO to change it.", booked: "Your appointment is confirmed." },
  Hindi: { name: "कृपया मरीज का पूरा नाम बताएं।", reason: "मुलाकात का कारण बताएं।", doctor: "कृपया डॉक्टर या विभाग चुनें।", date: "तारीख चुनें:\n1. आज\n2. कल\n3. अपनी तारीख (YYYY-MM-DD)", slot: "उपलब्ध समय चुनें। 1, 2 या 3 से reply करें।", confirm: "Appointment confirm करने के लिए YES लिखें, बदलने के लिए NO लिखें।", booked: "आपकी appointment confirm हो गई है।" },
  Marathi: { name: "कृपया रुग्णाचे पूर्ण नाव सांगा.", reason: "भेटीचे कारण सांगा.", doctor: "कृपया डॉक्टर किंवा विभाग निवडा.", date: "तारीख निवडा:\n1. आज\n2. उद्या\n3. तुमची तारीख (YYYY-MM-DD)", slot: "उपलब्ध वेळ निवडा. 1, 2 किंवा 3 ने reply करा.", confirm: "Appointment निश्चित करण्यासाठी YES लिहा, बदलण्यासाठी NO लिहा.", booked: "तुमची appointment निश्चित झाली आहे." },
} as const;

const clean = (value: string) => value.trim();
const validName = (value: string) => /^[\p{L}][\p{L}\s.'-]{1,59}$/u.test(clean(value));
const languageFor = (value: string): Language | null => ({ "1": "Marathi", marathi: "Marathi", mr: "Marathi", "2": "Hindi", hindi: "Hindi", hi: "Hindi", "3": "English", english: "English", en: "English" }[clean(value).toLowerCase()] as Language | undefined) ?? null;
const displayTime = (value: string) => { const [hour, minute] = value.slice(0, 5).split(":").map(Number); return `${((hour + 11) % 12) + 1}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`; };
const numbered = (items: string[], prompt: string) => `${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\n${prompt}`;
const isBooking = (value: string) => /\b(book|booking|appointment|doctor|visit|schedule)\b|अपॉइंटमेंट|appointment/i.test(value);

async function sendMetaMessage(phoneNumberId: string, encryptedToken: string, recipient: string, text: string) {
  const response = await fetch(`https://graph.facebook.com/v22.0/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${decrypt(encryptedToken)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: recipient, type: "text", text: { body: text } }),
  });
  if (!response.ok) throw new Error(`Meta Cloud API ${response.status}: ${await response.text()}`);
}

export async function GET(request: NextRequest) {
  console.log("Meta WhatsApp webhook GET received");
  const mode = request.nextUrl.searchParams.get("hub.mode");
  const token = request.nextUrl.searchParams.get("hub.verify_token") ?? "";
  const challenge = request.nextUrl.searchParams.get("hub.challenge");
  if (mode !== "subscribe" || !challenge) return NextResponse.json({ error: "Invalid verification request" }, { status: 400 });
  if (process.env.META_WEBHOOK_VERIFY_TOKEN && token === process.env.META_WEBHOOK_VERIFY_TOKEN) return new NextResponse(challenge, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  const { data, error } = await serviceClient().from("meta_connections").select("id").eq("verify_token_hash", secretHash(token)).maybeSingle();
  if (error) console.error("Meta verification lookup failed", error);
  return data ? new NextResponse(challenge, { headers: { "Content-Type": "text/plain; charset=utf-8" } }) : NextResponse.json({ error: "Verification token mismatch" }, { status: 403 });
}

export async function POST(request: NextRequest) {
  console.log("Meta WhatsApp webhook POST received");
  try {
    const payload = await request.json() as { entry?: Array<{ changes?: Array<{ value?: { metadata?: { phone_number_id?: string }; messages?: MetaMessage[] } }> }> };
    const value = payload.entry?.flatMap((entry) => entry.changes ?? []).map((change) => change.value).find((item) => item?.messages?.length);
    const incoming = value?.messages?.[0];
    const phoneNumberId = value?.metadata?.phone_number_id;
    const patientPhone = incoming?.from?.replace(/\D/g, "") ?? "";
    const text = incoming?.type === "text" ? clean(incoming.text?.body ?? "") : "";
    if (!phoneNumberId || !patientPhone || !text) return NextResponse.json({ ok: true });

    const db = serviceClient();
    const { data: connection, error: connectionError } = await db.from("meta_connections").select("*").eq("phone_number_id", phoneNumberId).maybeSingle();
    if (connectionError) throw connectionError;
    if (!connection) throw new Error("No hospital is connected to this WhatsApp Phone Number ID.");
    const hospitalId = connection.hospital_id as string;
    const now = new Date().toISOString();
    const { data: conversation, error: conversationError } = await db.from("conversations").upsert({ hospital_id: hospitalId, phone_number: patientPhone, updated_at: now }, { onConflict: "hospital_id,phone_number" }).select("id").single();
    if (conversationError || !conversation) throw conversationError ?? new Error("Could not create conversation.");
    const { error: inboundError } = await db.from("messages").insert({ conversation_id: conversation.id, role: "user", content: text });
    if (inboundError) throw inboundError;

    const { data: draftRow, error: draftError } = await db.from("appointment_drafts").select("*").eq("conversation_id", conversation.id).maybeSingle();
    if (draftError) throw draftError;
    let draft = draftRow as Draft | null;
    let reply = "";
    const reset = /^(restart|start over|new appointment|book again|cancel|stop|नवीन|पुन्हा)$/i.test(text);
    if (reset || !draft) {
      await db.from("appointment_drafts").upsert({ conversation_id: conversation.id, language: "Marathi", stage: "language", patient_name: null, doctor_or_department: null, preferred_date: null, reason: null, offered_slots: null, updated_at: now });
      reply = languageMenu;
    } else if (draft.stage === "language") {
      const language = languageFor(text);
      if (!language) reply = languageMenu;
      else { await db.from("appointment_drafts").update({ language, stage: "intent", updated_at: now }).eq("conversation_id", conversation.id); reply = intentMenu(language); }
    } else if (draft.stage === "intent") {
      const language = draft.language;
      if (text === "1" || isBooking(text)) { await db.from("appointment_drafts").update({ stage: "name", updated_at: now }).eq("conversation_id", conversation.id); reply = messages[language].name; }
      else if (text === "2" || /doctor|department|डॉक्टर|विभाग/i.test(text)) { const { data: doctors, error } = await db.from("doctors").select("name,department").eq("hospital_id", hospitalId).eq("enabled", true).order("department").order("name"); if (error) throw error; reply = doctors?.length ? numbered(doctors.map((doctor) => `${doctor.name} — ${doctor.department}`), messages[language].doctor) : "No doctors are currently available. Please contact the hospital."; }
      else if (text === "3" || /time|timing|hour|open|timings|वेळ|समय/i.test(text)) { const { data: settings, error } = await db.from("hospital_settings").select("hospital_name,opening_time,closing_time").eq("hospital_id", hospitalId).maybeSingle(); if (error) throw error; reply = `${settings?.hospital_name ?? "Hospital"} timings: ${displayTime(String(settings?.opening_time ?? "09:00"))} to ${displayTime(String(settings?.closing_time ?? "17:00"))}.\n\n${intentMenu(language)}`; }
      else reply = intentMenu(language);
    } else if (draft.stage === "name") {
      if (!validName(text)) reply = `${messages[draft.language].name}\nExample: Riya Patil`;
      else { await db.from("patients").upsert({ hospital_id: hospitalId, phone_number: patientPhone, full_name: text, last_seen: now }, { onConflict: "hospital_id,phone_number" }); await db.from("appointment_drafts").update({ patient_name: text, stage: "reason", updated_at: now }).eq("conversation_id", conversation.id); reply = messages[draft.language].reason; }
    } else if (draft.stage === "reason") {
      if (text.length < 2 || text.length > 240) reply = messages[draft.language].reason;
      else { const { data: doctors, error } = await db.from("doctors").select("id,name,department").eq("hospital_id", hospitalId).eq("enabled", true).order("department").order("name"); if (error) throw error; await db.from("appointment_drafts").update({ reason: text, stage: "doctor", updated_at: now }).eq("conversation_id", conversation.id); reply = doctors?.length ? numbered(doctors.map((doctor) => `${doctor.name} — ${doctor.department}`), messages[draft.language].doctor) : "No doctors are currently available. Please contact the hospital."; }
    } else if (draft.stage === "doctor") {
      const { data: doctors, error } = await db.from("doctors").select("id,name,department,working_days,start_time,end_time,consultation_duration").eq("hospital_id", hospitalId).eq("enabled", true).order("department").order("name");
      if (error) throw error;
      const list = (doctors ?? []) as Doctor[];
      const choice = Number(text);
      const doctor = Number.isInteger(choice) && choice > 0 ? list[choice - 1] : list.find((item) => `${item.name} ${item.department}`.toLowerCase().includes(text.toLowerCase()));
      if (!doctor) reply = numbered(list.map((item) => `${item.name} — ${item.department}`), messages[draft.language].doctor);
      else { await db.from("appointment_drafts").update({ doctor_or_department: doctor.id, stage: "date", updated_at: now }).eq("conversation_id", conversation.id); reply = messages[draft.language].date; }
    } else if (draft.stage === "date") {
      const tomorrow = new Date(`${todayInIndia()}T00:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const date = text === "1" ? todayInIndia() : text === "2" ? tomorrow.toISOString().slice(0, 10) : validDate(text) ? text : null;
      if (!date) reply = messages[draft.language].date;
      else { const { data: doctor, error } = await db.from("doctors").select("id,name,department,working_days,start_time,end_time,consultation_duration").eq("hospital_id", hospitalId).eq("id", draft.doctor_or_department ?? "").eq("enabled", true).maybeSingle(); if (error) throw error; const slots = doctor ? await availableSlots(hospitalId, doctor as Doctor, date) : []; if (!slots.length) reply = `No slots are available on ${date}.\n\n${messages[draft.language].date}`; else { await db.from("appointment_drafts").update({ preferred_date: date, offered_slots: slots, stage: "time", updated_at: now }).eq("conversation_id", conversation.id); reply = numbered(slots.slice(0, 3).map(displayTime), messages[draft.language].slot); } }
    } else if (draft.stage === "time") {
      const choice = Number(text);
      const slot = Number.isInteger(choice) && choice > 0 ? draft.offered_slots?.[choice - 1] : null;
      if (!slot) reply = numbered((draft.offered_slots ?? []).slice(0, 3).map(displayTime), messages[draft.language].slot);
      else { await db.from("appointment_drafts").update({ offered_slots: [slot], stage: "confirm", updated_at: now }).eq("conversation_id", conversation.id); const { data: doctor } = await db.from("doctors").select("name,department").eq("hospital_id", hospitalId).eq("id", draft.doctor_or_department ?? "").maybeSingle(); reply = `${draft.patient_name}\n${doctor?.name ?? "Doctor"} — ${doctor?.department ?? ""}\n${draft.preferred_date} at ${displayTime(slot)}\n${draft.reason ?? ""}\n\n${messages[draft.language].confirm}`; }
    } else if (draft.stage === "confirm") {
      if (!/^(yes|y|1|हो|haan|ha)$/i.test(text)) { await db.from("appointment_drafts").update({ stage: "date", offered_slots: null, updated_at: now }).eq("conversation_id", conversation.id); reply = messages[draft.language].date; }
      else { const slot = draft.offered_slots?.[0]; const { data: doctor } = await db.from("doctors").select("id,name,department,working_days,start_time,end_time,consultation_duration").eq("hospital_id", hospitalId).eq("id", draft.doctor_or_department ?? "").eq("enabled", true).maybeSingle(); const { data: patient } = await db.from("patients").select("id,full_name").eq("hospital_id", hospitalId).eq("phone_number", patientPhone).maybeSingle(); if (!slot || !doctor || !patient || !draft.preferred_date || !(await availableSlots(hospitalId, doctor as Doctor, draft.preferred_date)).includes(slot)) reply = `That slot is no longer available.\n\n${messages[draft.language].date}`; else { const { error } = await db.from("appointments").insert({ hospital_id: hospitalId, patient_id: patient.id, conversation_id: conversation.id, doctor_id: doctor.id, patient_name: draft.patient_name ?? patient.full_name, phone_number: patientPhone, doctor_name: doctor.name, department: doctor.department, appointment_date: draft.preferred_date, appointment_time: slot, reason: draft.reason, status: "upcoming" }); if (error?.code === "23505") reply = `That slot was just booked.\n\n${messages[draft.language].date}`; else if (error) throw error; else { await db.from("appointment_drafts").delete().eq("conversation_id", conversation.id); reply = `${messages[draft.language].booked}\n${doctor.name} — ${draft.preferred_date} at ${displayTime(slot)}`; } }
      }
    } else { await db.from("appointment_drafts").delete().eq("conversation_id", conversation.id); reply = languageMenu; }

    const { error: replyError } = await db.from("messages").insert({ conversation_id: conversation.id, role: "assistant", content: reply });
    if (replyError) throw replyError;
    await sendMetaMessage(connection.phone_number_id, connection.access_token_encrypted, patientPhone, reply);
    await db.from("meta_connections").update({ status: "connected", last_error: null, updated_at: now }).eq("id", connection.id);
  } catch (error) {
    console.error("Direct Meta WhatsApp webhook processing failed", error);
  }
  return NextResponse.json({ ok: true });
}

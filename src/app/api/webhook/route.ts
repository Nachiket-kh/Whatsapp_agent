import { NextRequest, NextResponse } from "next/server";
import { decrypt, secretHash } from "@/lib/crypto";
import { availableSlots, Doctor, todayInIndia, validDate } from "@/lib/n8n";
import { serviceClient } from "@/lib/hospital";
import { cleanupExpiredChatsWhenDue } from "@/lib/chat-retention";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Language = "English" | "Hindi" | "Marathi";
type Draft = {
  language: Language;
  stage: string;
  patient_name: string | null;
  doctor_or_department: string | null;
  preferred_date: string | null;
  reason: string | null;
  offered_slots: string[] | null;
};
type MetaMessage = { id?: string; from?: string; type?: string; text?: { body?: string } };

const languageMenu = "CareFlow Hospital Reception mein aapka swagat hai. Kripya bhasha chuniye:\n1. मराठी\n2. हिंदी\n3. English";
const intentMenu = (language: Language) => language === "Marathi"
  ? "नमस्कार! मी तुम्हाला कशी मदत करू?\n1. अपॉइंटमेंट बुक करा\n2. डॉक्टर / विभाग\n3. हॉस्पिटलच्या वेळा"
  : language === "Hindi"
    ? "नमस्ते! मैं आपकी कैसे मदद कर सकती हूँ?\n1. अपॉइंटमेंट बुक करें\n2. डॉक्टर / विभाग\n3. अस्पताल का समय"
    : "Hello! How can I help?\n1. Book an appointment\n2. Doctors / departments\n3. Hospital timings";
const messages = {
  English: {
    name: "Please share the patient's full name.", reason: "What is the reason for the visit?", doctor: "Please choose a doctor or department.",
    date: "Choose your date:\n1. Today\n2. Tomorrow\n3. Custom date (YYYY-MM-DD)", slot: "Choose an available time slot. Reply with 1, 2, or 3.",
    confirm: "Reply YES to confirm this appointment, or NO to choose another date.", booked: "Your appointment is confirmed.",
  },
  Hindi: {
    name: "कृपया मरीज का पूरा नाम बताएं।", reason: "मुलाकात का कारण बताएं।", doctor: "कृपया डॉक्टर या विभाग चुनें।",
    date: "तारीख चुनें:\n1. आज\n2. कल\n3. अपनी तारीख (YYYY-MM-DD)", slot: "उपलब्ध समय चुनें। 1, 2 या 3 से reply करें।",
    confirm: "Appointment confirm करने के लिए YES लिखें, बदलने के लिए NO लिखें।", booked: "आपकी appointment confirm हो गई है।",
  },
  Marathi: {
    name: "कृपया रुग्णाचे पूर्ण नाव सांगा.", reason: "भेटीचे कारण सांगा.", doctor: "कृपया डॉक्टर किंवा विभाग निवडा.",
    date: "तारीख निवडा:\n1. आज\n2. उद्या\n3. तुमची तारीख (YYYY-MM-DD)", slot: "उपलब्ध वेळ निवडा. 1, 2 किंवा 3 ने reply करा.",
    confirm: "Appointment निश्चित करण्यासाठी YES लिहा, बदलण्यासाठी NO लिहा.", booked: "तुमची appointment निश्चित झाली आहे.",
  },
} as const;

const clean = (value: string) => value.trim();
const validName = (value: string) => /^[\p{L}][\p{L}\s.'-]{1,59}$/u.test(clean(value));
const languageFor = (value: string): Language | null => ({ "1": "Marathi", marathi: "Marathi", "मराठी": "Marathi", mr: "Marathi", "2": "Hindi", hindi: "Hindi", "हिंदी": "Hindi", hi: "Hindi", "3": "English", english: "English", en: "English" }[clean(value).toLowerCase()] as Language | undefined) ?? null;
const displayTime = (value: string) => {
  const [hour, minute] = value.slice(0, 5).split(":").map(Number);
  return `${((hour + 11) % 12) + 1}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
};
const numbered = (items: string[], prompt: string) => `${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\n${prompt}`;
const isBooking = (value: string) => /\b(book|booking|appointment|visit|schedule|book kara|book karein)\b|अपॉइंटमेंट|भेट/i.test(value);
const needsMedicalStaff = (value: string) => /\b(pain|fever|medicine|tablet|symptom|diagnos|prescription|blood|chest|dard|bukhar|dawa|aushadh)\b|दर्द|बुखार|दवा|ताप|औषध|वेदना/i.test(value);
const isHospitalQuestion = (value: string) => /\b(department|specialist|doctor|available|timing|time|hours|open|close|address|contact|emergency|fees?)\b|डॉक्टर|विभाग|वेळ|समय|अस्पताल|हॉस्पिटल/i.test(value);

async function sendMetaMessage(phoneNumberId: string, encryptedToken: string, recipient: string, text: string) {
  const response = await fetch(`https://graph.facebook.com/v22.0/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${decrypt(encryptedToken)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to: recipient, type: "text", text: { body: text } }),
  });
  if (!response.ok) throw new Error(`Meta Cloud API ${response.status}: ${await response.text()}`);
}

async function getHospitalHelp(db: ReturnType<typeof serviceClient>, hospitalId: string, language: Language) {
  const [{ data: settings, error: settingsError }, { data: doctors, error: doctorsError }] = await Promise.all([
    db.from("hospital_settings").select("hospital_name,opening_time,closing_time,departments").eq("hospital_id", hospitalId).maybeSingle(),
    db.from("doctors").select("name,department").eq("hospital_id", hospitalId).eq("enabled", true).order("department").order("name"),
  ]);
  if (settingsError) throw settingsError;
  if (doctorsError) throw doctorsError;
  const doctorList = (doctors ?? []).map((doctor) => `${doctor.name} - ${doctor.department}`).join("\n") || "No doctors are currently marked available.";
  const departments = settings?.departments?.length ? settings.departments.join(", ") : "Please ask the hospital reception.";
  const prefix = language === "Marathi" ? "हॉस्पिटलची माहिती" : language === "Hindi" ? "अस्पताल की जानकारी" : "Hospital information";
  const labels = language === "Marathi" ? { timing: "वेळ", departments: "विभाग", doctors: "उपलब्ध डॉक्टर" } : language === "Hindi" ? { timing: "समय", departments: "विभाग", doctors: "उपलब्ध डॉक्टर" } : { timing: "Timings", departments: "Departments", doctors: "Available doctors" };
  return `${prefix}: ${settings?.hospital_name ?? "CareFlow Hospital"}\n${labels.timing}: ${displayTime(String(settings?.opening_time ?? "09:00"))} to ${displayTime(String(settings?.closing_time ?? "17:00"))}\n${labels.departments}: ${departments}\n${labels.doctors}:\n${doctorList}\n\n${intentMenu(language)}`;
}

// This table is added by supabase/meta-migration.sql. The fallback keeps an
// already deployed installation operational until the migration is applied.
async function acquireWebhookEvent(db: ReturnType<typeof serviceClient>, hospitalId: string, conversationId: string, messageId?: string) {
  if (!messageId) return { eventId: null, duplicate: false };
  const { data, error } = await db.from("whatsapp_webhook_events")
    .upsert({ hospital_id: hospitalId, conversation_id: conversationId, provider: "meta", provider_message_id: messageId, status: "processing" }, { onConflict: "provider,provider_message_id", ignoreDuplicates: true })
    .select("id");
  if (error) {
    if (["42P01", "PGRST205"].includes(String(error.code ?? ""))) {
      console.warn("Webhook idempotency migration is not installed yet; continuing without event deduplication.");
      return { eventId: null, duplicate: false };
    }
    throw error;
  }
  if (data?.[0]?.id) return { eventId: data[0].id as string, duplicate: false };

  const { data: existing, error: existingError } = await db.from("whatsapp_webhook_events").select("id,status").eq("provider", "meta").eq("provider_message_id", messageId).maybeSingle();
  if (existingError || !existing) throw existingError ?? new Error("Could not read webhook event.");
  if (existing.status !== "failed") return { eventId: existing.id as string, duplicate: true };

  const { data: retried, error: retryError } = await db.from("whatsapp_webhook_events")
    .update({ status: "processing", updated_at: new Date().toISOString() })
    .eq("id", existing.id).eq("status", "failed").select("id");
  if (retryError) throw retryError;
  return retried?.[0]?.id ? { eventId: retried[0].id as string, duplicate: false } : { eventId: existing.id as string, duplicate: true };
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
  let db: ReturnType<typeof serviceClient> | null = null;
  let eventId: string | null = null;
  try {
    const payload = await request.json() as { entry?: Array<{ changes?: Array<{ value?: { metadata?: { phone_number_id?: string }; messages?: MetaMessage[] } }> }> };
    const value = payload.entry?.flatMap((entry) => entry.changes ?? []).map((change) => change.value).find((item) => item?.messages?.length);
    const incoming = value?.messages?.[0];
    const phoneNumberId = value?.metadata?.phone_number_id;
    const patientPhone = incoming?.from?.replace(/\D/g, "") ?? "";
    const text = incoming?.type === "text" ? clean(incoming.text?.body ?? "") : "";
    if (!phoneNumberId || !patientPhone || !text) return NextResponse.json({ ok: true });

    db = serviceClient();
    const { data: connection, error: connectionError } = await db.from("meta_connections").select("*").eq("phone_number_id", phoneNumberId).maybeSingle();
    if (connectionError) throw connectionError;
    if (!connection) throw new Error("No hospital is connected to this WhatsApp Phone Number ID.");
    const hospitalId = connection.hospital_id as string;
    await cleanupExpiredChatsWhenDue(hospitalId);
    const now = new Date().toISOString();
    const { data: conversation, error: conversationError } = await db.from("conversations")
      .upsert({ hospital_id: hospitalId, phone_number: patientPhone, updated_at: now }, { onConflict: "hospital_id,phone_number" }).select("id").single();
    if (conversationError || !conversation) throw conversationError ?? new Error("Could not create conversation.");

    const event = await acquireWebhookEvent(db, hospitalId, conversation.id, incoming?.id);
    eventId = event.eventId;
    if (event.duplicate) return NextResponse.json({ ok: true, duplicate: true });

    const { error: inboundError } = await db.from("messages").insert({ conversation_id: conversation.id, role: "user", content: text });
    if (inboundError) throw inboundError;
    const { data: draftRow, error: draftError } = await db.from("appointment_drafts").select("*").eq("conversation_id", conversation.id).maybeSingle();
    if (draftError) throw draftError;
    const draft = draftRow as Draft | null;
    let reply = "";
    const reset = /^(restart|start over|new appointment|book again|cancel|stop|navin|punha|नवीन|पुन्हा)$/i.test(text);

    if (reset) {
      await db.from("appointment_drafts").upsert({ conversation_id: conversation.id, language: "Marathi", stage: "language", patient_name: null, doctor_or_department: null, preferred_date: null, reason: null, offered_slots: null, updated_at: now });
      reply = languageMenu;
    } else if (!draft) {
      // The first interaction always asks for a language. Once chosen, every
      // subsequent prompt is rendered in that language's native script.
      await db.from("appointment_drafts").upsert({ conversation_id: conversation.id, language: "Marathi", stage: "language", patient_name: null, doctor_or_department: null, preferred_date: null, reason: null, offered_slots: null, updated_at: now });
      reply = languageMenu;
    } else if (draft.stage === "language") {
      const language = languageFor(text);
      if (!language) reply = languageMenu;
      else { await db.from("appointment_drafts").update({ language, stage: "intent", updated_at: now }).eq("conversation_id", conversation.id); reply = intentMenu(language); }
    } else if (draft.stage === "intent") {
      // In the intent menu 1, 2, and 3 are actions. Only explicit language
      // names/codes switch language here; numeric language choices belong to
      // the separate language-selection step.
      const requestedLanguage = /^(marathi|mr|hindi|hi|english|en)$/i.test(clean(text)) ? languageFor(text) : null;
      if (requestedLanguage) { await db.from("appointment_drafts").update({ language: requestedLanguage, updated_at: now }).eq("conversation_id", conversation.id); reply = intentMenu(requestedLanguage); }
      else if (needsMedicalStaff(text)) reply = draft.language === "Marathi" ? "मी डॉक्टर किंवा हॉस्पिटल स्टाफकडून खात्री करून सांगतो. आपत्कालीन स्थिती असल्यास त्वरित जवळच्या emergency department मध्ये जा." : draft.language === "Hindi" ? "मैं डॉक्टर या अस्पताल स्टाफ से confirm करके बताता हूँ। Emergency हो तो तुरंत nearest emergency department जाएँ।" : "I will ask a doctor or hospital staff member to confirm. For an emergency, please go to the nearest emergency department immediately.";
      else if (text === "2" || text === "3" || isHospitalQuestion(text)) reply = await getHospitalHelp(db, hospitalId, draft.language);
      else if (text === "1" || isBooking(text)) { await db.from("appointment_drafts").update({ stage: "name", updated_at: now }).eq("conversation_id", conversation.id); reply = messages[draft.language].name; }
      else reply = intentMenu(draft.language);
    } else if (draft.stage === "name") {
      if (!validName(text)) reply = `${messages[draft.language].name}\nExample: Riya Patil`;
      else {
        const { error } = await db.from("patients").upsert({ hospital_id: hospitalId, phone_number: patientPhone, full_name: text, last_seen: now }, { onConflict: "hospital_id,phone_number" });
        if (error) throw error;
        await db.from("appointment_drafts").update({ patient_name: text, stage: "reason", updated_at: now }).eq("conversation_id", conversation.id);
        reply = messages[draft.language].reason;
      }
    } else if (draft.stage === "reason") {
      if (text.length < 2 || text.length > 240) reply = `${messages[draft.language].reason}\nPlease use 2 to 240 characters.`;
      else {
        const { data: doctors, error } = await db.from("doctors").select("id,name,department").eq("hospital_id", hospitalId).eq("enabled", true).order("department").order("name");
        if (error) throw error;
        if (!doctors?.length) reply = "No doctors are currently available. Please contact the hospital.";
        else { await db.from("appointment_drafts").update({ reason: text, stage: "doctor", updated_at: now }).eq("conversation_id", conversation.id); reply = numbered(doctors.map((doctor) => `${doctor.name} - ${doctor.department}`), messages[draft.language].doctor); }
      }
    } else if (draft.stage === "doctor") {
      const { data: doctors, error } = await db.from("doctors").select("id,name,department,working_days,start_time,end_time,consultation_duration").eq("hospital_id", hospitalId).eq("enabled", true).order("department").order("name");
      if (error) throw error;
      const list = (doctors ?? []) as Doctor[];
      const choice = Number(text);
      const doctor = Number.isInteger(choice) && choice > 0 ? list[choice - 1] : list.find((item) => `${item.name} ${item.department}`.toLowerCase().includes(text.toLowerCase()));
      if (!doctor) reply = numbered(list.map((item) => `${item.name} - ${item.department}`), messages[draft.language].doctor);
      else { await db.from("appointment_drafts").update({ doctor_or_department: doctor.id, stage: "date", updated_at: now }).eq("conversation_id", conversation.id); reply = messages[draft.language].date; }
    } else if (draft.stage === "date") {
      const tomorrow = new Date(`${todayInIndia()}T00:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
      const date = text === "1" ? todayInIndia() : text === "2" ? tomorrow.toISOString().slice(0, 10) : validDate(text) ? text : null;
      if (!date) reply = `${messages[draft.language].date}\nPlease enter a valid future date.`;
      else {
        const { data: doctor, error } = await db.from("doctors").select("id,name,department,working_days,start_time,end_time,consultation_duration").eq("hospital_id", hospitalId).eq("id", draft.doctor_or_department ?? "").eq("enabled", true).maybeSingle();
        if (error) throw error;
        const slots = doctor ? await availableSlots(hospitalId, doctor as Doctor, date) : [];
        if (!slots.length) reply = `No slots are available on ${date}.\n\n${messages[draft.language].date}`;
        else { const offered = slots.slice(0, 3); await db.from("appointment_drafts").update({ preferred_date: date, offered_slots: offered, stage: "time", updated_at: now }).eq("conversation_id", conversation.id); reply = numbered(offered.map(displayTime), messages[draft.language].slot); }
      }
    } else if (draft.stage === "time") {
      const choice = Number(text);
      const slot = Number.isInteger(choice) && choice > 0 ? draft.offered_slots?.[choice - 1] : null;
      if (!slot) reply = numbered((draft.offered_slots ?? []).map(displayTime), messages[draft.language].slot);
      else {
        await db.from("appointment_drafts").update({ offered_slots: [slot], stage: "confirm", updated_at: now }).eq("conversation_id", conversation.id);
        const { data: doctor } = await db.from("doctors").select("name,department").eq("hospital_id", hospitalId).eq("id", draft.doctor_or_department ?? "").maybeSingle();
        reply = `${draft.patient_name}\n${doctor?.name ?? "Doctor"} - ${doctor?.department ?? ""}\n${draft.preferred_date} at ${displayTime(slot)}\n${draft.reason ?? ""}\n\n${messages[draft.language].confirm}`;
      }
    } else if (draft.stage === "confirm") {
      if (!/^(yes|y|1|ho|haan|ha|हो)$/i.test(text)) {
        await db.from("appointment_drafts").update({ stage: "date", offered_slots: null, updated_at: now }).eq("conversation_id", conversation.id);
        reply = messages[draft.language].date;
      } else {
        const slot = draft.offered_slots?.[0];
        const { data: doctor } = await db.from("doctors").select("id,name,department,working_days,start_time,end_time,consultation_duration").eq("hospital_id", hospitalId).eq("id", draft.doctor_or_department ?? "").eq("enabled", true).maybeSingle();
        const { data: patient } = await db.from("patients").select("id,full_name").eq("hospital_id", hospitalId).eq("phone_number", patientPhone).maybeSingle();
        if (!slot || !doctor || !patient || !draft.preferred_date || !(await availableSlots(hospitalId, doctor as Doctor, draft.preferred_date)).includes(slot)) {
          await db.from("appointment_drafts").update({ stage: "date", offered_slots: null, updated_at: now }).eq("conversation_id", conversation.id);
          reply = `That slot is no longer available.\n\n${messages[draft.language].date}`;
        } else {
          const { error } = await db.from("appointments").insert({ hospital_id: hospitalId, patient_id: patient.id, conversation_id: conversation.id, doctor_id: doctor.id, patient_name: draft.patient_name ?? patient.full_name, phone_number: patientPhone, doctor_name: doctor.name, department: doctor.department, appointment_date: draft.preferred_date, appointment_time: slot, reason: draft.reason, status: "upcoming" });
          if (error?.code === "23505") {
            await db.from("appointment_drafts").update({ stage: "date", offered_slots: null, updated_at: now }).eq("conversation_id", conversation.id);
            reply = `That slot was just booked.\n\n${messages[draft.language].date}`;
          } else if (error) throw error;
          else { await db.from("appointment_drafts").delete().eq("conversation_id", conversation.id); reply = `${messages[draft.language].booked}\n${doctor.name} - ${draft.preferred_date} at ${displayTime(slot)}`; }
        }
      }
    } else {
      await db.from("appointment_drafts").delete().eq("conversation_id", conversation.id);
      reply = languageMenu;
    }

    const { error: replyError } = await db.from("messages").insert({ conversation_id: conversation.id, role: "assistant", content: reply });
    if (replyError) throw replyError;
    await sendMetaMessage(connection.phone_number_id, connection.access_token_encrypted, patientPhone, reply);
    await db.from("meta_connections").update({ status: "connected", last_error: null, updated_at: now }).eq("id", connection.id);
    if (eventId) await db.from("whatsapp_webhook_events").update({ status: "completed", completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", eventId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Direct Meta WhatsApp webhook processing failed", error);
    if (db && eventId) {
      const { error: eventError } = await db.from("whatsapp_webhook_events").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", eventId);
      if (eventError) console.error("Failed to mark WhatsApp webhook event as failed", eventError);
    }
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

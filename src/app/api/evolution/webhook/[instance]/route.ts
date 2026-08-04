import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { secretHash } from "@/lib/crypto";
import { evolutionRequest, type EvolutionConnection } from "@/lib/evolution";
import { serviceClient } from "@/lib/hospital";

export const runtime = "nodejs";

type Language = "English" | "Hindi" | "Marathi";
type Draft = { language: Language; stage: string; patient_name: string | null; doctor_or_department: string | null; preferred_date: string | null; offered_slots: string[] | null };
type DoctorOption = { id: string; name: string; department: string };
type AppointmentDoctor = DoctorOption & { working_days: string[]; start_time: string; end_time: string; consultation_duration: number };
type HospitalHours = { opening_time: string; closing_time: string; slot_duration: number };
const words = {
  English: { welcome: "Hello 👋 Welcome to ABC Hospital. May I know your name?", doctor: "Which doctor or department would you like to visit?", date: "What date would you prefer? Please reply in YYYY-MM-DD format.", slots: "Available timings are:\n", choose: "Please reply with your preferred time.", confirmed: "Your appointment is confirmed.", unavailable: "Sorry, that time is unavailable. Available timings are:\n" },
  Hindi: { welcome: "नमस्ते 👋 ABC Hospital में आपका स्वागत है। कृपया अपना नाम बताएं?", doctor: "आप किस डॉक्टर या विभाग में जाना चाहते हैं?", date: "आप कौन-सी तारीख पसंद करेंगे? कृपया YYYY-MM-DD में बताएं।", slots: "उपलब्ध समय हैं:\n", choose: "कृपया अपना पसंदीदा समय बताएं।", confirmed: "आपकी अपॉइंटमेंट कन्फर्म हो गई है।", unavailable: "माफ़ कीजिए, यह समय उपलब्ध नहीं है। उपलब्ध समय हैं:\n" },
  Marathi: { welcome: "नमस्कार 👋 ABC Hospital मध्ये आपले स्वागत आहे. कृपया आपले नाव सांगा?", doctor: "आपल्याला कोणत्या डॉक्टरांना किंवा विभागाला भेटायचे आहे?", date: "आपल्याला कोणती तारीख हवी आहे? कृपया YYYY-MM-DD मध्ये सांगा.", slots: "उपलब्ध वेळा आहेत:\n", choose: "कृपया पसंतीची वेळ सांगा.", confirmed: "आपली अपॉइंटमेंट निश्चित झाली आहे.", unavailable: "माफ करा, ही वेळ उपलब्ध नाही. उपलब्ध वेळा आहेत:\n" },
};
const languageMenu = "Welcome to ABC Hospital.\n\nPlease select your language for appointment booking:\n1. English\n2. Hindi\n3. Marathi\n\nReply with 1, 2, or 3.";
const dateMenu = "Please select an appointment date:\n1. Today\n2. Tomorrow\n3. Custom date (reply with YYYY-MM-DD)";
const selectedLanguage = (text: string): Language | null => {
  const value = text.trim().toLowerCase();
  if (["1", "english", "en"].includes(value)) return "English";
  if (["2", "hindi", "hi"].includes(value)) return "Hindi";
  if (["3", "marathi", "mr"].includes(value)) return "Marathi";
  return null;
};
const languageOf = (text: string): Language => /ळ|मध्ये|आहे/.test(text) ? "Marathi" : /[\u0900-\u097F]/.test(text) ? "Hindi" : "English";
const dateOf = (text: string) => text.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1] ?? null;
const timeOf = (text: string) => { const m = text.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)?\b/i); if (!m) return null; let h = +m[1]; if (m[3]?.toUpperCase() === "PM" && h < 12) h += 12; if (m[3]?.toUpperCase() === "AM" && h === 12) h = 0; return `${String(h).padStart(2, "0")}:${m[2]}`; };
const minutes = (value: string) => { const [hour, minute] = value.slice(0, 5).split(":").map(Number); return hour * 60 + minute; };
const slotValue = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
const indianToday = () => {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
  const get = (part: string) => parts.find((item) => item.type === part)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
};
const tomorrowInIndia = () => {
  const [year, month, day] = indianToday().split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + 1));
  return date.toISOString().slice(0, 10);
};
const weekdayFor = (date: string) => new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
const display = (slot: string) => { const [h, m] = slot.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`; };
const listSlots = (prefix: string, slots: string[], suffix: string) => `${prefix}${slots.map((slot, index) => `${index + 1}. ${display(slot)}`).join("\n")}\n${suffix}`;
const doctorsPrompt = (language: Language, doctors: DoctorOption[]) => {
  if (!doctors.length) return language === "Hindi" ? "अभी कोई डॉक्टर उपलब्ध नहीं है। कृपया अस्पताल से संपर्क करें।" : language === "Marathi" ? "सध्या कोणतेही डॉक्टर उपलब्ध नाहीत. कृपया रुग्णालयाशी संपर्क साधा." : "There are no doctors available right now. Please contact the hospital.";
  const heading = language === "Hindi" ? "उपलब्ध डॉक्टर और विभाग:" : language === "Marathi" ? "उपलब्ध डॉक्टर आणि विभाग:" : "Available doctors and departments:";
  const instruction = language === "Hindi" ? "कृपया 1, 2, 3 में जवाब दें या डॉक्टर/विभाग का नाम लिखें।" : language === "Marathi" ? "कृपया 1, 2, 3 मध्ये उत्तर द्या किंवा डॉक्टर/विभागाचे नाव लिहा." : "Reply with 1, 2, 3, or type a doctor or department name.";
  return `${heading}\n${doctors.map((doctor, index) => `${index + 1}. ${doctor.name} — ${doctor.department}`).join("\n")}\n\n${instruction}`;
};

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

async function chooseDoctorWithGemini(text: string, doctors: DoctorOption[]) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || !doctors.length) return null;
  const catalog = doctors.map((doctor) => ({ id: doctor.id, name: doctor.name, department: doctor.department }));
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent", {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `Patient request: ${text}\n\nAvailable hospital doctors: ${JSON.stringify(catalog)}\n\nChoose the single best matching doctor by id. If no doctor or department is a clear match, return null. Return JSON only: {"doctorId":"id-or-null"}.` }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 80, responseMimeType: "application/json" },
      }),
    });
    if (!response.ok) throw new Error(`Gemini doctor matching ${response.status}: ${await response.text()}`);
    const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const raw = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    const result = JSON.parse(raw) as { doctorId?: string | null };
    return doctors.find((doctor) => doctor.id === result.doctorId) ?? null;
  } catch (error) {
    console.error("Gemini doctor matching failed", error);
    return null;
  }
}

async function dateWithGemini(text: string) {
  const exact = dateOf(text);
  if (exact) return exact;
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const today = indianToday();
  try {
    const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent", {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: `Today in India is ${today}. Convert this patient appointment date request into one future ISO date (YYYY-MM-DD): ${text}. If it is ambiguous or invalid, return null. Return JSON only: {"date":"YYYY-MM-DD-or-null"}.` }] }], generationConfig: { temperature: 0, maxOutputTokens: 50, responseMimeType: "application/json" } }),
    });
    if (!response.ok) throw new Error(`Gemini date matching ${response.status}: ${await response.text()}`);
    const payload = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const raw = payload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
    const value = (JSON.parse(raw) as { date?: string | null }).date ?? null;
    return value && /^20\d{2}-\d{2}-\d{2}$/.test(value) && value >= today ? value : null;
  } catch (error) { console.error("Gemini date matching failed", error); return null; }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ instance: string }> }) {
  const { instance } = await params;
  console.log("Evolution webhook POST received", { instance });
  try {
    const token = request.nextUrl.searchParams.get("token");
    const payload = await request.json() as Record<string, unknown>;
    const supabase = serviceClient();
    const { data: savedConnection, error: connectionError } = await supabase.from("evolution_connections").select("*").eq("instance_name", instance).maybeSingle();
    const cloudSecret = process.env.EVOLUTION_WEBHOOK_SECRET;
    const usesConnectionSecret = Boolean(token && savedConnection && secretHash(token) === savedConnection.webhook_secret_hash);
    const usesCloudSecret = Boolean(token && cloudSecret && token === cloudSecret);
    // The stable secret is for Evolution Cloud's global Webhook screen; the
    // per-connection secret remains supported for the in-app configuration.
    if (connectionError || !savedConnection || !token || (!usesConnectionSecret && !usesCloudSecret)) { console.error("Evolution webhook authentication failed", { instance, connectionError }); return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); }
    const event = String(payload.event ?? "");
    // Evolution v2 emits event names such as `messages.upsert`, whereas older
    // releases use `MESSAGES_UPSERT`.  Normalise both spellings.
    const eventName = event.toUpperCase().replace(/[.\-]/g, "_");
    console.log("Evolution webhook event received", { instance, event });
    if (eventName.includes("CONNECTION") || eventName.includes("QRCODE")) {
      const data = payload.data as Record<string, unknown> | undefined;
      const state = String(data?.state ?? data?.status ?? "").toLowerCase();
      const qr = String(data?.qrcode ?? data?.base64 ?? "") || null;
      const status = state === "open" || state === "connected" ? "connected" : qr ? "qr_pending" : "disconnected";
      const { error } = await supabase.from("evolution_connections").update({ status, qr_code: qr, updated_at: new Date().toISOString() }).eq("id", savedConnection.id);
      if (error) console.error("Evolution connection status update failed", error);
      return NextResponse.json({ ok: true });
    }
    if (!eventName.includes("MESSAGES_UPSERT")) return NextResponse.json({ ok: true });
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
    // Start every new chat with an explicit language choice. This prevents a
    // greeting from falling through to the general AI and echoing the message.
    if (!state) {
      await supabase.from("appointment_drafts").upsert({ conversation_id: conversation.id, language: languageOf(incoming.text), stage: "language" });
      reply = languageMenu;
    }
    else if (state.stage === "language") {
      const language = selectedLanguage(incoming.text);
      if (!language) reply = languageMenu;
      else {
        await supabase.from("appointment_drafts").update({ language, stage: "name", updated_at: now }).eq("conversation_id", conversation.id);
        reply = words[language].welcome;
      }
    }
    else if (state?.stage === "name") {
      await supabase.from("patients").upsert({ hospital_id: hospitalId, phone_number: incoming.phone, full_name: incoming.text, last_seen: now }, { onConflict: "hospital_id,phone_number" });
      const { data: doctors, error: doctorsError } = await supabase.from("doctors").select("id,name,department").eq("hospital_id", hospitalId).eq("enabled", true).order("department").order("name");
      if (doctorsError) console.error("Available doctors lookup failed", doctorsError);
      await supabase.from("appointment_drafts").update({ patient_name: incoming.text, stage: "doctor", updated_at: now }).eq("conversation_id", conversation.id);
      reply = doctorsPrompt(state.language, (doctors ?? []) as DoctorOption[]);
    }
    else if (state?.stage === "doctor") {
      const { data: doctors, error: doctorsError } = await supabase.from("doctors").select("id,name,department").eq("hospital_id", hospitalId).eq("enabled", true).order("department").order("name");
      if (doctorsError) console.error("Doctor selection lookup failed", doctorsError);
      const available = (doctors ?? []) as DoctorOption[];
      const search = incoming.text.toLowerCase();
      const option = Number(incoming.text.trim());
      const directMatch = Number.isInteger(option) && option >= 1 && option <= available.length ? available[option - 1] : available.find((item) => item.name.toLowerCase().includes(search) || item.department.toLowerCase().includes(search) || search.includes(item.name.toLowerCase()) || search.includes(item.department.toLowerCase()));
      const doctor = directMatch ?? await chooseDoctorWithGemini(incoming.text, available);
      if (!doctor) reply = doctorsPrompt(state.language, available);
      else {
        await supabase.from("appointment_drafts").update({ doctor_or_department: doctor.id, stage: "date", updated_at: now }).eq("conversation_id", conversation.id);
        reply = `${doctor.name} — ${doctor.department}\n\n${dateMenu}`;
      }
    }
    else if (state?.stage === "date") {
      const choice = incoming.text.trim();
      const date = choice === "1" ? indianToday() : choice === "2" ? tomorrowInIndia() : choice === "3" ? null : await dateWithGemini(incoming.text);
      if (!date) reply = choice === "3" ? "Please reply with your custom date in YYYY-MM-DD format." : dateMenu;
      else {
        const [{ data: doctor, error: doctorError }, { data: hospitalHours, error: hoursError }, { data: booked, error: bookedError }] = await Promise.all([
          supabase.from("doctors").select("id,name,department,working_days,start_time,end_time,consultation_duration").eq("id", state.doctor_or_department!).eq("hospital_id", hospitalId).single(),
          supabase.from("hospital_settings").select("opening_time,closing_time,slot_duration").eq("hospital_id", hospitalId).maybeSingle(),
          supabase.from("appointments").select("appointment_time").eq("hospital_id", hospitalId).eq("doctor_id", state.doctor_or_department!).eq("appointment_date", date).eq("status", "upcoming"),
        ]);
        if (doctorError) console.error("Appointment doctor lookup failed", doctorError);
        if (hoursError) console.error("Hospital hours lookup failed", hoursError);
        if (bookedError) console.error("Booked slot lookup failed", bookedError);
        const selectedDoctor = doctor as AppointmentDoctor | null;
        const hours = hospitalHours as HospitalHours | null;
        if (!selectedDoctor) throw new Error("Selected doctor no longer exists.");
        if (!selectedDoctor.working_days.includes(weekdayFor(date))) {
          reply = `${selectedDoctor.name} is not available on ${weekdayFor(date)}.\n\n${dateMenu}`;
        } else {
          const start = Math.max(minutes(selectedDoctor.start_time), minutes(hours?.opening_time ?? selectedDoctor.start_time));
          const end = Math.min(minutes(selectedDoctor.end_time), minutes(hours?.closing_time ?? selectedDoctor.end_time));
          const duration = selectedDoctor.consultation_duration || hours?.slot_duration || 20;
          const busy = new Set((booked ?? []).map((item) => String(item.appointment_time).slice(0, 5)));
          const nowIndia = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
          const nowMinutes = Number(nowIndia.find((part) => part.type === "hour")?.value ?? 0) * 60 + Number(nowIndia.find((part) => part.type === "minute")?.value ?? 0);
          const slots = Array.from({ length: Math.max(0, Math.floor((end - start) / duration)) }, (_, index) => slotValue(start + index * duration))
            .filter((slot) => !busy.has(slot) && (date !== indianToday() || minutes(slot) > nowMinutes))
            .slice(0, 6);
          if (!slots.length) reply = "No unbooked slots are available within the hospital's working hours for this date. Please choose another date.";
          else {
            await supabase.from("appointment_drafts").update({ preferred_date: date, offered_slots: slots, stage: "time", updated_at: now }).eq("conversation_id", conversation.id);
            reply = listSlots(words[state.language].slots, slots, words[state.language].choose);
          }
        }
      }
    }
    else if (state?.stage === "time") {
      const option = Number(incoming.text.trim());
      const selected = Number.isInteger(option) && option >= 1 && option <= (state.offered_slots?.length ?? 0) ? state.offered_slots?.[option - 1] : timeOf(incoming.text);
      if (!selected || !state.offered_slots?.includes(selected)) reply = listSlots(words[state.language].unavailable, state.offered_slots ?? [], words[state.language].choose);
      else {
        const [{ data: patient, error: patientError }, { data: doctor, error: doctorError }] = await Promise.all([
          supabase.from("patients").select("id,full_name").eq("hospital_id", hospitalId).eq("phone_number", incoming.phone).single(),
          supabase.from("doctors").select("id,name,department").eq("hospital_id", hospitalId).eq("id", state.doctor_or_department!).single(),
        ]);
        if (patientError || doctorError || !patient || !doctor) throw patientError ?? doctorError ?? new Error("Patient or doctor record was not found.");
        const { error } = await supabase.from("appointments").insert({ hospital_id: hospitalId, patient_id: patient.id, conversation_id: conversation.id, doctor_id: doctor.id, patient_name: state.patient_name ?? patient.full_name ?? "Patient", phone_number: incoming.phone, doctor_name: doctor.name, department: doctor.department, appointment_date: state.preferred_date, appointment_time: selected });
        if (error?.code === "23505") {
          console.error("Appointment slot became unavailable", error);
          reply = listSlots(words[state.language].unavailable, state.offered_slots ?? [], words[state.language].choose);
        } else if (error) {
          console.error("Appointment insert failed", error);
          reply = "We could not save the appointment. Please try again or contact the hospital.";
        } else {
          const { error: draftError } = await supabase.from("appointment_drafts").delete().eq("conversation_id", conversation.id);
          if (draftError) console.error("Appointment draft cleanup failed", draftError);
          reply = `${words[state.language].confirmed}\n${doctor.name} • ${state.preferred_date} • ${display(selected)}`;
        }
      }
    }
    if (!reply) reply = await generalReply(incoming.text);
    if (!reply) throw new Error("AI returned an empty reply.");
    const { error: replyError } = await supabase.from("messages").insert({ conversation_id: conversation.id, role: "assistant", content: reply });
    if (replyError) throw replyError;
    await sendWithRetry(connection, incoming.phone, reply);
    await supabase.from("evolution_connections").update({ status: "connected", last_error: null, updated_at: now }).eq("id", savedConnection.id);
    return NextResponse.json({ ok: true });
  } catch (error) { console.error("Evolution webhook processing failed", error); return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 }); }
}

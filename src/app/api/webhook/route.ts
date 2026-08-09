import { NextRequest, NextResponse } from "next/server";
import { decrypt, secretHash } from "@/lib/crypto";
import { availableSlots, Doctor, slotBlockReason, todayInIndia, validDate, weekdayForDate } from "@/lib/n8n";
import { serviceClient } from "@/lib/hospital";
import { cleanupExpiredChatsWhenDue } from "@/lib/chat-retention";
import { askGroqReceptionist } from "@/lib/groq";

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
type MetaMessage = {
  id?: string; from?: string; type?: string; text?: { body?: string };
  interactive?: {
    type?: string;
    button_reply?: { id?: string; title?: string };
    list_reply?: { id?: string; title?: string; description?: string };
    nfm_reply?: { response_json?: string };
  };
};
type MetaOutbound = Record<string, unknown>;
type TapResult = { log: string; outgoing: MetaOutbound[] };

const languageMenu = "Welcome to CareFlow Hospital Reception. We will assist you in English by default. To switch language, reply: Marathi / मराठी or Hindi / हिंदी.";
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
const languageFor = (value: string): Language | null => {
  const normalized = clean(value).toLowerCase().normalize("NFC");
  // Accept the common English spellings plus the Hindi and Marathi spellings
  // patients normally type in WhatsApp. This deliberately supports phrases
  // such as "मराठीत बोल" and "हिन्दी में" as well as a single word.
  if (["1", "marathi", "mr", "मराठी", "मराठीत", "मराठीमध्ये"].includes(normalized) || /(^|\s)(marathi|मराठी|मराठीत)(\s|$)/u.test(normalized)) return "Marathi";
  if (["2", "hindi", "hi", "हिंदी", "हिन्दी", "हिंदी में", "हिन्दी में"].includes(normalized) || /(^|\s)(hindi|हिंदी|हिन्दी)(\s|$)/u.test(normalized)) return "Hindi";
  if (["3", "english", "en"].includes(normalized) || /(^|\s)(english|inglish)(\s|$)/u.test(normalized)) return "English";
  return null;
};
// Keep the conversation in the patient's chosen language. When they naturally
// switch scripts mid-chat, recognise common Hindi/Marathi phrases too.
const languageFromMessage = (value: string): Language | null => {
  const explicit = languageFor(value);
  if (explicit && !/^[123]$/.test(clean(value))) return explicit;
  if (!/[\u0900-\u097f]/u.test(value)) return null;
  if (/(आहे|आहेत|मला|माझे|तुमचे|उद्या|कृपया|सांगा|वेळा|मराठीत|नमस्कार)/u.test(value)) return "Marathi";
  if (/(है|हैं|मुझे|मेरा|आपका|कल|कृपया|बताएं|समय|हिन्दी|हिंदी|नमस्ते|हैलो)/u.test(value)) return "Hindi";
  return null;
};
const aiUnavailable = (language: Language) => language === "Marathi"
  ? "सध्या AI मदत उपलब्ध नाही. अपॉइंटमेंट बुक करण्यासाठी 1, डॉक्टर/विभागांसाठी 2, किंवा हॉस्पिटल वेळेसाठी 3 reply करा."
  : language === "Hindi"
    ? "अभी AI सहायता उपलब्ध नहीं है। अपॉइंटमेंट बुक करने के लिए 1, डॉक्टर/विभाग के लिए 2, या अस्पताल समय के लिए 3 reply करें।"
    : "The AI assistant is temporarily unavailable. Reply 1 to book an appointment, 2 for doctors/departments, or 3 for hospital timings.";
const isToday = (value: string) => /^(1|today|aaj|आज|आजचा|आजची)$/iu.test(clean(value));
const isTomorrow = (value: string) => /^(2|tomorrow|kal|कल|उद्या)$/iu.test(clean(value));
const isConfirmation = (value: string) => /^(yes|y|1|ho|haan|ha|हाँ|हां|हो|होय)$/iu.test(clean(value));
const displayTime = (value: string) => {
  const [hour, minute] = value.slice(0, 5).split(":").map(Number);
  return `${((hour + 11) % 12) + 1}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`;
};
const numbered = (items: string[], prompt: string) => `${items.map((item, index) => `${index + 1}. ${item}`).join("\n")}\n\n${prompt}`;
const isBooking = (value: string) => /\b(book|booking|appointment|visit|schedule|book kara|book karein)\b|अपॉइंटमेंट|भेट/i.test(value);
const needsMedicalStaff = (value: string) => /\b(pain|fever|medicine|tablet|symptom|diagnos|prescription|blood|chest|dard|bukhar|dawa|aushadh)\b|दर्द|बुखार|दवा|ताप|औषध|वेदना/i.test(value);
const isHospitalQuestion = (value: string) => /\b(department|specialist|doctor|available|timing|time|hours|open|close|address|contact|emergency|fees?)\b|डॉक्टर|विभाग|वेळ|समय|अस्पताल|हॉस्पिटल/i.test(value);

const short = (value: string, length: number) => value.length > length ? `${value.slice(0, Math.max(0, length - 1))}…` : value;
const plainMessage = (text: string): MetaOutbound => ({ messaging_product: "whatsapp", type: "text", text: { body: text } });
const buttonsMessage = (body: string, buttons: Array<{ id: string; title: string }>): MetaOutbound => ({
  messaging_product: "whatsapp", type: "interactive", interactive: {
    type: "button", body: { text: body }, action: { buttons: buttons.slice(0, 3).map((button) => ({ type: "reply", reply: { id: button.id, title: short(button.title, 20) } })) },
  },
});
const listMessage = (body: string, button: string, rows: Array<{ id: string; title: string; description?: string }>): MetaOutbound => ({
  messaging_product: "whatsapp", type: "interactive", interactive: {
    type: "list", body: { text: body }, action: { button: short(button, 20), sections: [{ title: "Options", rows: rows.slice(0, 10).map((row) => ({ id: row.id, title: short(row.title, 24), ...(row.description ? { description: short(row.description, 72) } : {}) })) }] },
  },
});
const tapCopy = {
  English: { service: "Please choose a service.", book: "Book appointment", doctors: "Doctors", timings: "Timings", department: "Choose a department.", departments: "Departments", doctor: "Choose a doctor.", date: "Choose your preferred appointment date.", today: "Today", tomorrow: "Tomorrow", custom: "Custom date", slot: "Please select an available appointment time.", slots: "Time slots", noSlots: "No available appointment slots are currently available for this date. Please choose another date.", noDoctor: "No doctors are currently available in that department.", name: "Please type the patient's full name to continue.", invalidName: "Please type a valid full name, for example: Riya Patil.", summary: "Appointment summary", patient: "Patient", departmentLabel: "Department", dateLabel: "Date", time: "Time", confirm: "Confirm", back: "Back", cancel: "Cancel", confirmed: "Appointment confirmed", unavailable: "That slot is no longer available. Please select another available slot." },
  Hindi: { service: "कृपया सेवा चुनें।", book: "बुक अपॉइंटमेंट", doctors: "डॉक्टर", timings: "समय", department: "कृपया विभाग चुनें।", departments: "विभाग", doctor: "कृपया डॉक्टर चुनें।", date: "अपनी पसंदीदा अपॉइंटमेंट तारीख चुनें।", today: "आज", tomorrow: "कल", custom: "अन्य तारीख", slot: "कृपया उपलब्ध अपॉइंटमेंट समय चुनें।", slots: "समय", noSlots: "इस तारीख के लिए कोई अपॉइंटमेंट स्लॉट उपलब्ध नहीं है। कृपया दूसरी तारीख चुनें।", noDoctor: "इस विभाग में अभी कोई डॉक्टर उपलब्ध नहीं है।", name: "कृपया मरीज का पूरा नाम लिखें।", invalidName: "कृपया सही पूरा नाम लिखें, उदाहरण: रिया पाटिल।", summary: "अपॉइंटमेंट सारांश", patient: "मरीज", departmentLabel: "विभाग", dateLabel: "तारीख", time: "समय", confirm: "पुष्टि करें", back: "वापस", cancel: "रद्द करें", confirmed: "अपॉइंटमेंट पक्की हो गई है", unavailable: "यह स्लॉट अब उपलब्ध नहीं है। कृपया दूसरा उपलब्ध स्लॉट चुनें।" },
  Marathi: { service: "कृपया सेवा निवडा.", book: "अपॉइंटमेंट बुक", doctors: "डॉक्टर", timings: "वेळा", department: "कृपया विभाग निवडा.", departments: "विभाग", doctor: "कृपया डॉक्टर निवडा.", date: "कृपया तुमची अपॉइंटमेंटची तारीख निवडा.", today: "आज", tomorrow: "उद्या", custom: "इतर तारीख", slot: "कृपया उपलब्ध अपॉइंटमेंटची वेळ निवडा.", slots: "वेळा", noSlots: "या तारखेसाठी कोणतीही अपॉइंटमेंटची वेळ उपलब्ध नाही. कृपया दुसरी तारीख निवडा.", noDoctor: "या विभागात सध्या डॉक्टर उपलब्ध नाहीत.", name: "कृपया रुग्णाचे पूर्ण नाव लिहा.", invalidName: "कृपया योग्य पूर्ण नाव लिहा, उदाहरण: रिया पाटील.", summary: "अपॉइंटमेंट सारांश", patient: "रुग्ण", departmentLabel: "विभाग", dateLabel: "तारीख", time: "वेळ", confirm: "निश्चित करा", back: "मागे", cancel: "रद्द करा", confirmed: "अपॉइंटमेंट निश्चित झाली आहे", unavailable: "ही वेळ आता उपलब्ध नाही. कृपया दुसरी उपलब्ध वेळ निवडा." },
} as const;
const t = (language: Language) => tapCopy[language];
const languageButtons = () => buttonsMessage("Please choose your preferred language.", [
  { id: "tap:language:mr", title: "मराठी" }, { id: "tap:language:hi", title: "हिंदी" }, { id: "tap:language:en", title: "English" },
]);
const hospitalInformationTitle = (language: Language) => {
  if (language === "Hindi") return "अस्पताल जानकारी";
  if (language === "Marathi") return "हॉस्पिटल माहिती";
  return "Hospital information";
};

const menuButtons = (language: Language) => buttonsMessage(t(language).service, [
  { id: "tap:menu:book", title: t(language).book },
  { id: "tap:menu:info", title: hospitalInformationTitle(language) },
]);
const dateButtons = (language: Language) => buttonsMessage(t(language).date, [
  { id: "tap:date:today", title: t(language).today }, { id: "tap:date:tomorrow", title: t(language).tomorrow }, { id: "tap:date:custom", title: t(language).custom },
]);
const choiceId = (message: MetaMessage) => message.interactive?.button_reply?.id ?? message.interactive?.list_reply?.id ?? "";
async function handleReminderReply(db: ReturnType<typeof serviceClient>, hospitalId: string, patientPhone: string, choice: string) {
  const match = /^reminder:([0-9a-f-]{36}):(yes|no)$/.exec(choice);
  if (!match) return null;
  const [, appointmentId, answer] = match;
  const { data: appointment, error } = await db.from("appointments")
    .select("id,patient_name,appointment_date,appointment_time,status")
    .eq("id", appointmentId)
    .eq("hospital_id", hospitalId)
    .eq("phone_number", patientPhone)
    .maybeSingle();
  if (error) throw error;
  if (!appointment) return "We could not find that appointment. Please contact the hospital reception.";
  if (appointment.status !== "upcoming") return `This appointment is already ${appointment.status}.`;
  if (answer === "no") {
    const { error: cancelError } = await db.from("appointments").update({ status: "cancelled" }).eq("id", appointment.id).eq("status", "upcoming");
    if (cancelError) throw cancelError;
    return "Your appointment has been cancelled. You can message us anytime to book another appointment.";
  }
  return "Thank you for confirming. We will see you at the hospital.";
}
const flowDate = (message: MetaMessage) => {
  const raw = message.interactive?.nfm_reply?.response_json;
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const date = value.appointment_date ?? value.date ?? value.preferred_date;
    return typeof date === "string" ? date : null;
  } catch { return null; }
};

async function sendMetaMessage(phoneNumberId: string, encryptedToken: string, recipient: string, message: string | MetaOutbound) {
  const response = await fetch(`https://graph.facebook.com/v22.0/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${decrypt(encryptedToken)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ ...(typeof message === "string" ? plainMessage(message) : message), to: recipient }),
  });
  if (!response.ok) throw new Error(`Meta Cloud API ${response.status}: ${await response.text()}`);
}

async function getHospitalHelp(db: ReturnType<typeof serviceClient>, hospitalId: string, language: Language) {
  const { data: settings, error: settingsError } = await db
    .from("hospital_settings")
    .select("hospital_name,opening_time,closing_time,departments,receptionist_number")
    .eq("hospital_id", hospitalId)
    .maybeSingle();
  if (settingsError) throw settingsError;
  const departmentsOnly = settings?.departments?.length ? settings.departments.join(", ") : language === "Hindi" ? "कृपया अस्पताल रिसेप्शन से पूछें।" : language === "Marathi" ? "कृपया हॉस्पिटल रिसेप्शनला विचारा." : "Please contact the hospital reception.";
  const receptionist = settings?.receptionist_number || (language === "Hindi" ? "रिसेप्शन नंबर उपलब्ध नहीं है।" : language === "Marathi" ? "रिसेप्शन नंबर उपलब्ध नाही." : "Reception number is not available.");
  const hospitalInfo = language === "Hindi"
    ? `अस्पताल जानकारी: ${settings?.hospital_name ?? "Hospital"}\nसमय: ${displayTime(String(settings?.opening_time ?? "09:00"))} से ${displayTime(String(settings?.closing_time ?? "17:00"))}\nविभाग: ${departmentsOnly}\nरिसेप्शनिस्ट नंबर: ${receptionist}`
    : language === "Marathi"
      ? `हॉस्पिटल माहिती: ${settings?.hospital_name ?? "Hospital"}\nवेळ: ${displayTime(String(settings?.opening_time ?? "09:00"))} ते ${displayTime(String(settings?.closing_time ?? "17:00"))}\nविभाग: ${departmentsOnly}\nरिसेप्शनिस्ट क्रमांक: ${receptionist}`
      : `Hospital information: ${settings?.hospital_name ?? "Hospital"}\nTimings: ${displayTime(String(settings?.opening_time ?? "09:00"))} to ${displayTime(String(settings?.closing_time ?? "17:00"))}\nDepartments: ${departmentsOnly}\nReceptionist number: ${receptionist}`;
  return hospitalInfo;
}

async function getGroqHelp(db: ReturnType<typeof serviceClient>, hospitalId: string, language: Language, patientMessage: string) {
  const [{ data: settings, error: settingsError }, { data: doctors, error: doctorsError }] = await Promise.all([
    db.from("hospital_settings").select("hospital_name,opening_time,closing_time,departments").eq("hospital_id", hospitalId).maybeSingle(),
    db.from("doctors").select("name,department").eq("hospital_id", hospitalId).eq("enabled", true).order("department").order("name"),
  ]);
  if (settingsError || doctorsError) { console.error("Groq hospital context lookup failed", settingsError ?? doctorsError); return null; }
  const { data: configuredAi, error: configuredAiError } = await db.from("ai_connections").select("provider,api_key_encrypted,model,enabled").eq("hospital_id", hospitalId).eq("enabled", true).maybeSingle();
  if (configuredAiError && !["42P01", "PGRST205"].includes(String(configuredAiError.code ?? ""))) console.error("AI connection lookup failed", configuredAiError);
  const provider = configuredAi?.provider === "openai" ? "openai" : "groq";
  const apiKey = configuredAi?.api_key_encrypted ? decrypt(configuredAi.api_key_encrypted) : undefined;
  const indiaNow = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const nowPart = (name: string) => indiaNow.find((part) => part.type === name)?.value ?? "";
  return askGroqReceptionist({ language, patientMessage, provider, apiKey, model: configuredAi?.model ?? undefined, context: { hospitalName: settings?.hospital_name ?? "Our hospital", openingTime: String(settings?.opening_time ?? "09:00"), closingTime: String(settings?.closing_time ?? "17:00"), departments: settings?.departments ?? [], doctors: (doctors ?? []).map((doctor) => `${doctor.name} (${doctor.department})`), currentIndiaDate: `${nowPart("year")}-${nowPart("month")}-${nowPart("day")}`, currentIndiaTime: `${nowPart("hour")}:${nowPart("minute")} IST` } });
}

async function departmentPicker(db: ReturnType<typeof serviceClient>, hospitalId: string, language: Language): Promise<MetaOutbound> {
  const { data: doctors, error } = await db.from("doctors").select("department").eq("hospital_id", hospitalId).eq("enabled", true).order("department");
  if (error) throw error;
  const departments = [...new Set((doctors ?? []).map((doctor) => String(doctor.department).trim()).filter(Boolean))];
  if (!departments.length) return plainMessage(language === "Hindi" ? "अभी किसी विभाग में डॉक्टर उपलब्ध नहीं हैं।" : language === "Marathi" ? "सध्या कोणत्याही विभागात डॉक्टर उपलब्ध नाहीत." : "No departments have an available doctor right now. Please contact the hospital.");
  return listMessage(t(language).department, t(language).departments, departments.map((department) => ({ id: `tap:department:${encodeURIComponent(department)}`, title: department })));
}

const displayDate = (date: string, language: Language) => new Intl.DateTimeFormat(language === "Hindi" ? "hi-IN" : language === "Marathi" ? "mr-IN" : "en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(new Date(`${date}T12:00:00Z`));

async function customDatePicker(db: ReturnType<typeof serviceClient>, hospitalId: string, doctor: Doctor, language: Language): Promise<TapResult> {
  const start = new Date(`${todayInIndia()}T00:00:00Z`); start.setUTCDate(start.getUTCDate() + 2);
  const dates: string[] = [];
  for (let offset = 0; offset < 90 && dates.length < 10; offset += 1) {
    const candidate = new Date(start); candidate.setUTCDate(start.getUTCDate() + offset);
    const date = candidate.toISOString().slice(0, 10);
    if ((await availableSlots(hospitalId, doctor, date)).length) dates.push(date);
  }
  if (!dates.length) return { log: "No future dates have availability.", outgoing: [plainMessage(t(language).noSlots), dateButtons(language)] };
  return { log: `Sent ${dates.length} future dates with availability.`, outgoing: [listMessage(t(language).custom, t(language).custom, dates.map((date) => ({ id: `custom_date_${date}`, title: displayDate(date, language) })))] };
}

const unavailableDayMessage = (language: Language, reason: "sunday" | "doctor_unavailable" | "hospital_closed", doctor: Doctor, date: string) => {
  if (reason === "sunday") return language === "Hindi" ? "रविवार को अपॉइंटमेंट उपलब्ध नहीं हैं। कृपया दूसरी तारीख चुनें।" : language === "Marathi" ? "रविवारी अपॉइंटमेंट उपलब्ध नाहीत. कृपया दुसरी तारीख निवडा." : "Appointments are not available on Sunday. Please choose another date.";
  if (reason === "hospital_closed") return language === "Hindi" ? "आज अस्पताल की अपॉइंटमेंट सेवा बंद हो चुकी है। कृपया कल या कोई दूसरी तारीख चुनें।" : language === "Marathi" ? "आजची हॉस्पिटल अपॉइंटमेंट सेवा बंद झाली आहे. कृपया उद्या किंवा दुसरी तारीख निवडा." : "The hospital is closed for appointments today. Please choose tomorrow or another date.";
  const day = weekdayForDate(date);
  return language === "Hindi" ? `${doctor.name} ${day} को उपलब्ध नहीं हैं। कृपया दूसरी तारीख चुनें।` : language === "Marathi" ? `${doctor.name} ${day} ला उपलब्ध नाहीत. कृपया दुसरी तारीख निवडा.` : `${doctor.name} is not available on ${day}. Please choose another date.`;
};

async function slotsPicker(db: ReturnType<typeof serviceClient>, hospitalId: string, conversationId: string, now: string, doctor: Doctor, date: string, language: Language): Promise<TapResult> {
  const { data: settings, error: settingsError } = await db.from("hospital_settings").select("closing_time").eq("hospital_id", hospitalId).maybeSingle();
  if (settingsError) throw settingsError;
  const blockReason = slotBlockReason(doctor, date, String(settings?.closing_time ?? doctor.end_time));
  if (blockReason) {
    await db.from("appointment_drafts").update({ stage: "tap_date", preferred_date: null, offered_slots: null, updated_at: now }).eq("conversation_id", conversationId);
    return { log: `Appointment date unavailable: ${blockReason}.`, outgoing: [plainMessage(unavailableDayMessage(language, blockReason, doctor, date)), dateButtons(language)] };
  }
  const slots = (await availableSlots(hospitalId, doctor, date)).slice(0, 15);
  if (!slots.length) {
    // Return to the date state before showing date buttons again. Without this,
    // a second date tap could be mistaken for an invalid time-slot selection.
    await db.from("appointment_drafts").update({ stage: "tap_date", preferred_date: null, offered_slots: null, updated_at: now }).eq("conversation_id", conversationId);
    return { log: `No slots available for ${date}.`, outgoing: [plainMessage(t(language).noSlots), dateButtons(language)] };
  }
  const groups = Array.from({ length: Math.ceil(slots.length / 10) }, (_, index) => slots.slice(index * 10, index * 10 + 10));
  return {
    log: `Sent ${slots.length} live appointment slot${slots.length === 1 ? "" : "s"} for ${date}.`,
    outgoing: groups.map((group, index) => listMessage(groups.length === 1 ? t(language).slot : `${t(language).slot} (${index * 10 + 1}-${index * 10 + group.length} / ${slots.length})`, t(language).slots, group.map((slot) => ({ id: `slot_${date}_${slot.replace(":", "-")}`, title: displayTime(slot) })))),
  };
}

async function runTapBooking(input: {
  db: ReturnType<typeof serviceClient>; hospitalId: string; conversationId: string; patientPhone: string; draft: Draft | null; message: MetaMessage; text: string; now: string;
}): Promise<TapResult | null> {
  const { db, hospitalId, conversationId, patientPhone, message, text, now } = input;
  let draft = input.draft;
  const tap = choiceId(message);
  const selectedFlowDate = flowDate(message);
  if (!draft) {
    await db.from("appointment_drafts").upsert({ conversation_id: conversationId, language: "English", stage: "tap_language", patient_name: null, doctor_or_department: null, preferred_date: null, reason: null, offered_slots: null, updated_at: now });
    return { log: "Sent interactive language selection.", outgoing: [languageButtons()] };
  }
  if (!draft.stage.startsWith("tap_")) return null;

  if (draft.stage === "tap_language") {
    const language = tap === "tap:language:mr" ? "Marathi" : tap === "tap:language:hi" ? "Hindi" : tap === "tap:language:en" ? "English" : null;
    if (!language) return { log: "Waiting for language button selection.", outgoing: [languageButtons()] };
    await db.from("appointment_drafts").update({ language, stage: "tap_menu", updated_at: now }).eq("conversation_id", conversationId);
    return { log: `Language selected: ${language}.`, outgoing: [menuButtons(language)] };
  }

  if (draft.stage === "tap_menu") {
    if (tap === "tap:menu:info") return { log: "Sent hospital information.", outgoing: [plainMessage(await getHospitalHelp(db, hospitalId, draft.language)), menuButtons(draft.language)] };
    if (tap !== "tap:menu:book") return { log: "Waiting for menu selection.", outgoing: [menuButtons(draft.language)] };
    const { data: patient, error } = await db.from("patients").select("full_name").eq("hospital_id", hospitalId).eq("phone_number", patientPhone).maybeSingle();
    if (error) throw error;
    if (!patient?.full_name) {
      await db.from("appointment_drafts").update({ stage: "tap_name", updated_at: now }).eq("conversation_id", conversationId);
      return { log: "Requested patient name.", outgoing: [plainMessage(t(draft.language).name)] };
    }
    await db.from("appointment_drafts").update({ patient_name: patient.full_name, stage: "tap_department", updated_at: now }).eq("conversation_id", conversationId);
    return { log: "Sent interactive department list.", outgoing: [await departmentPicker(db, hospitalId, draft.language)] };
  }

  if (draft.stage === "tap_name") {
    if (message.type !== "text" || !validName(text)) return { log: "Waiting for a valid patient name.", outgoing: [plainMessage(t(draft.language).invalidName)] };
    const { error } = await db.from("patients").upsert({ hospital_id: hospitalId, phone_number: patientPhone, full_name: clean(text), last_seen: now }, { onConflict: "hospital_id,phone_number" });
    if (error) throw error;
    await db.from("appointment_drafts").update({ patient_name: clean(text), stage: "tap_department", updated_at: now }).eq("conversation_id", conversationId);
    return { log: "Patient name saved; sent department list.", outgoing: [await departmentPicker(db, hospitalId, draft.language)] };
  }

  if (draft.stage === "tap_department") {
    if (!tap.startsWith("tap:department:")) return { log: "Waiting for department selection.", outgoing: [await departmentPicker(db, hospitalId, draft.language)] };
    const department = decodeURIComponent(tap.slice("tap:department:".length));
    const { data: doctors, error } = await db.from("doctors").select("id,name,department").eq("hospital_id", hospitalId).eq("department", department).eq("enabled", true).order("name");
    if (error) throw error;
    if (!doctors?.length) return { log: "Selected department has no available doctors.", outgoing: [plainMessage(t(draft.language).noDoctor), await departmentPicker(db, hospitalId, draft.language)] };
    await db.from("appointment_drafts").update({ doctor_or_department: department, stage: "tap_doctor", updated_at: now }).eq("conversation_id", conversationId);
    return { log: `Sent ${doctors.length} available doctor choices.`, outgoing: [listMessage(t(draft.language).doctor, t(draft.language).doctors, doctors.map((doctor) => ({ id: `tap:doctor:${doctor.id}`, title: doctor.name, description: doctor.department })))] };
  }

  if (draft.stage === "tap_doctor") {
    if (!tap.startsWith("tap:doctor:")) return { log: "Waiting for doctor selection.", outgoing: [plainMessage("Please choose a doctor from the list.")] };
    const doctorId = tap.slice("tap:doctor:".length);
    const { data: doctor, error } = await db.from("doctors").select("id").eq("hospital_id", hospitalId).eq("id", doctorId).eq("enabled", true).maybeSingle();
    if (error) throw error;
    if (!doctor) return { log: "Unavailable doctor selection.", outgoing: [plainMessage(t(draft.language).noDoctor), await departmentPicker(db, hospitalId, draft.language)] };
    await db.from("appointment_drafts").update({ doctor_or_department: doctor.id, stage: "tap_date", updated_at: now }).eq("conversation_id", conversationId);
    return { log: "Sent date reply buttons.", outgoing: [dateButtons(draft.language)] };
  }

  if (draft.stage === "tap_date") {
    if (tap === "tap:date:custom") {
      const { data: doctor, error } = await db.from("doctors").select("id,name,department,working_days,start_time,end_time,consultation_duration").eq("hospital_id", hospitalId).eq("id", draft.doctor_or_department ?? "").eq("enabled", true).maybeSingle();
      if (error) throw error;
      if (!doctor) return { log: "Doctor unavailable before custom-date selection.", outgoing: [plainMessage(t(draft.language).noDoctor), menuButtons(draft.language)] };
      await db.from("appointment_drafts").update({ stage: "tap_custom_date", updated_at: now }).eq("conversation_id", conversationId);
      return customDatePicker(db, hospitalId, doctor as Doctor, draft.language);
    }
    const tomorrow = new Date(`${todayInIndia()}T00:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const date = selectedFlowDate ?? (tap === "tap:date:today" ? todayInIndia() : tap === "tap:date:tomorrow" ? tomorrow.toISOString().slice(0, 10) : null);
    if (!date || !validDate(date)) return { log: "Waiting for date selection.", outgoing: [dateButtons(draft.language)] };
    const { data: doctor, error } = await db.from("doctors").select("id,name,department,working_days,start_time,end_time,consultation_duration").eq("hospital_id", hospitalId).eq("id", draft.doctor_or_department ?? "").eq("enabled", true).maybeSingle();
    if (error) throw error;
    if (!doctor) return { log: "Doctor unavailable before date selection.", outgoing: [plainMessage("That doctor is no longer available. Please start again."), menuButtons(draft.language)] };
    await db.from("appointment_drafts").update({ preferred_date: date, stage: "tap_slot", updated_at: now }).eq("conversation_id", conversationId);
    return slotsPicker(db, hospitalId, conversationId, now, doctor as Doctor, date, draft.language);
  }

  if (draft.stage === "tap_custom_date") {
    const date = tap.startsWith("custom_date_") ? tap.slice("custom_date_".length) : null;
    if (!date || !validDate(date)) return { log: "Waiting for custom-date selection.", outgoing: [plainMessage(t(draft.language).custom)] };
    const { data: doctor, error } = await db.from("doctors").select("id,name,department,working_days,start_time,end_time,consultation_duration").eq("hospital_id", hospitalId).eq("id", draft.doctor_or_department ?? "").eq("enabled", true).maybeSingle();
    if (error) throw error;
    if (!doctor) return { log: "Doctor unavailable before custom-date selection.", outgoing: [plainMessage(t(draft.language).noDoctor), menuButtons(draft.language)] };
    await db.from("appointment_drafts").update({ preferred_date: date, stage: "tap_slot", updated_at: now }).eq("conversation_id", conversationId);
    return slotsPicker(db, hospitalId, conversationId, now, doctor as Doctor, date, draft.language);
  }

  if (draft.stage === "tap_slot") {
    if (tap.startsWith("tap:date:") || tap.startsWith("custom_date_")) return { log: "Ignored stale date selection after slot list was sent.", outgoing: [] };
    const slotPrefix = draft.preferred_date ? `slot_${draft.preferred_date}_` : "";
    const slotValue = slotPrefix && tap.startsWith(slotPrefix) ? tap.slice(slotPrefix.length) : "";
    const slot = /^\d{2}-\d{2}$/.test(slotValue) ? slotValue.replace("-", ":") : null;
    if (!slot || !draft.preferred_date) return { log: "Waiting for slot selection.", outgoing: [plainMessage(t(draft.language).slot)] };
    const { data: doctor, error } = await db.from("doctors").select("name,department").eq("hospital_id", hospitalId).eq("id", draft.doctor_or_department ?? "").maybeSingle();
    if (error) throw error;
    await db.from("appointment_drafts").update({ offered_slots: [slot], stage: "tap_confirm", updated_at: now }).eq("conversation_id", conversationId);
    const summary = `${t(draft.language).summary}\n${t(draft.language).patient}: ${draft.patient_name ?? t(draft.language).patient}\n${t(draft.language).doctors}: ${doctor?.name ?? "-"}\n${t(draft.language).departmentLabel}: ${doctor?.department ?? ""}\n${t(draft.language).dateLabel}: ${displayDate(draft.preferred_date, draft.language)}\n${t(draft.language).time}: ${displayTime(slot)}`;
    return { log: "Sent appointment confirmation buttons.", outgoing: [buttonsMessage(summary, [{ id: "tap:confirm", title: t(draft.language).confirm }, { id: "tap:back", title: t(draft.language).back }, { id: "tap:cancel", title: t(draft.language).cancel }])] };
  }

  if (draft.stage === "tap_confirm") {
    if (tap === "tap:cancel") { await db.from("appointment_drafts").delete().eq("conversation_id", conversationId); return { log: "Appointment booking cancelled.", outgoing: [plainMessage(draft.language === "Hindi" ? "अपॉइंटमेंट बुकिंग रद्द कर दी गई है।" : draft.language === "Marathi" ? "अपॉइंटमेंट बुकिंग रद्द केली आहे." : "Appointment booking cancelled."), menuButtons(draft.language)] }; }
    if (tap === "tap:back") { await db.from("appointment_drafts").update({ stage: "tap_date", offered_slots: null, updated_at: now }).eq("conversation_id", conversationId); return { log: "Returned to date selection.", outgoing: [dateButtons(draft.language)] }; }
    if (tap !== "tap:confirm") return { log: "Waiting for confirmation button.", outgoing: [plainMessage(`${t(draft.language).confirm}, ${t(draft.language).back}, ${t(draft.language).cancel}`)] };
    const slot = draft.offered_slots?.[0];
    const [{ data: doctor, error: doctorError }, { data: patient, error: patientError }] = await Promise.all([
      db.from("doctors").select("id,name,department,working_days,start_time,end_time,consultation_duration").eq("hospital_id", hospitalId).eq("id", draft.doctor_or_department ?? "").eq("enabled", true).maybeSingle(),
      db.from("patients").select("id,full_name").eq("hospital_id", hospitalId).eq("phone_number", patientPhone).maybeSingle(),
    ]);
    if (doctorError || patientError) throw doctorError ?? patientError;
    if (!slot || !doctor || !patient || !draft.preferred_date || !(await availableSlots(hospitalId, doctor as Doctor, draft.preferred_date)).includes(slot)) {
      await db.from("appointment_drafts").update({ stage: "tap_date", offered_slots: null, updated_at: now }).eq("conversation_id", conversationId);
      return { log: "Selected slot became unavailable; refreshed slots.", outgoing: [plainMessage(t(draft.language).unavailable), dateButtons(draft.language)] };
    }
    const { error } = await db.from("appointments").insert({ hospital_id: hospitalId, patient_id: patient.id, conversation_id: conversationId, doctor_id: doctor.id, patient_name: draft.patient_name ?? patient.full_name, phone_number: patientPhone, doctor_name: doctor.name, department: doctor.department, appointment_date: draft.preferred_date, appointment_time: slot, reason: draft.reason, status: "upcoming" });
    if (error?.code === "23505") {
      await db.from("appointment_drafts").update({ stage: "tap_date", offered_slots: null, updated_at: now }).eq("conversation_id", conversationId);
      return { log: "Slot conflicted during insert; returned to date selection.", outgoing: [plainMessage(t(draft.language).unavailable), dateButtons(draft.language)] };
    }
    if (error) throw error;
    await db.from("appointment_drafts").delete().eq("conversation_id", conversationId);
    return { log: "Appointment confirmed and saved to dashboard.", outgoing: [plainMessage(`${t(draft.language).confirmed}: ${doctor.name} (${doctor.department}), ${displayDate(draft.preferred_date, draft.language)} ${displayTime(slot)}.`)] };
  }
  return null;
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
    if (!incoming || !phoneNumberId || !patientPhone || (!text && incoming.type !== "interactive")) return NextResponse.json({ ok: true });

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
    let draft = draftRow as Draft | null;
    let reply = "";
    let interactiveReplies: MetaOutbound[] | null = null;
    const reset = /^(restart|start over|new appointment|book again|cancel|stop|navin|punha|नवीन|पुन्हा)$/i.test(text);

    const reminderReply = await handleReminderReply(db, hospitalId, patientPhone, choiceId(incoming));
    const tapResult = reminderReply ? null : await runTapBooking({ db, hospitalId, conversationId: conversation.id, patientPhone, draft, message: incoming, text, now });

    if (!tapResult && draft && draft.stage !== "language") {
      const detectedLanguage = languageFromMessage(text);
      if (detectedLanguage && detectedLanguage !== draft.language) {
        await db.from("appointment_drafts").update({ language: detectedLanguage, updated_at: now }).eq("conversation_id", conversation.id);
        draft = { ...draft, language: detectedLanguage };
      }
    }

    if (reminderReply) {
      reply = reminderReply;
      interactiveReplies = [plainMessage(reply)];
    } else if (tapResult) {
      reply = tapResult.log;
      interactiveReplies = tapResult.outgoing;
    } else if (reset) {
      await db.from("appointment_drafts").upsert({ conversation_id: conversation.id, language: "English", stage: "tap_language", patient_name: null, doctor_or_department: null, preferred_date: null, reason: null, offered_slots: null, updated_at: now });
      reply = "Sent interactive language selection.";
      interactiveReplies = [languageButtons()];
    } else if (!draft) {
      await db.from("appointment_drafts").upsert({ conversation_id: conversation.id, language: "English", stage: "intent", patient_name: null, doctor_or_department: null, preferred_date: null, reason: null, offered_slots: null, updated_at: now });
      reply = `${languageMenu}\n\n${intentMenu("English")}`;
    } else if (draft.stage === "language") {
      const language = languageFor(text);
      if (!language) reply = languageMenu;
      else { await db.from("appointment_drafts").update({ language, stage: "intent", updated_at: now }).eq("conversation_id", conversation.id); reply = intentMenu(language); }
    } else if (draft.stage === "intent") {
      // In the intent menu 1, 2, and 3 are actions. Only explicit language
      // names/codes switch language here; numeric language choices belong to
      // the separate language-selection step.
      const requestedLanguage = /^[123]$/.test(clean(text)) ? null : languageFor(text);
      if (requestedLanguage) { await db.from("appointment_drafts").update({ language: requestedLanguage, updated_at: now }).eq("conversation_id", conversation.id); reply = intentMenu(requestedLanguage); }
      else if (needsMedicalStaff(text)) reply = draft.language === "Marathi" ? "मी डॉक्टर किंवा हॉस्पिटल स्टाफकडून खात्री करून सांगतो. आपत्कालीन स्थिती असल्यास त्वरित जवळच्या emergency department मध्ये जा." : draft.language === "Hindi" ? "मैं डॉक्टर या अस्पताल स्टाफ से confirm करके बताता हूँ। Emergency हो तो तुरंत nearest emergency department जाएँ।" : "I will ask a doctor or hospital staff member to confirm. For an emergency, please go to the nearest emergency department immediately.";
      else if (text === "2" || text === "3" || isHospitalQuestion(text)) reply = await getHospitalHelp(db, hospitalId, draft.language);
      else if (text === "1" || isBooking(text)) { await db.from("appointment_drafts").update({ stage: "name", updated_at: now }).eq("conversation_id", conversation.id); reply = messages[draft.language].name; }
      else {
        const informativeReply = await getGroqHelp(db, hospitalId, draft.language, text);
        reply = informativeReply ? `${informativeReply}\n\n${intentMenu(draft.language)}` : `${aiUnavailable(draft.language)}\n\n${intentMenu(draft.language)}`;
      }
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
      const date = isToday(text) ? todayInIndia() : isTomorrow(text) ? tomorrow.toISOString().slice(0, 10) : validDate(text) ? text : null;
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
      if (!isConfirmation(text)) {
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
    for (const message of interactiveReplies ?? [plainMessage(reply)]) await sendMetaMessage(connection.phone_number_id, connection.access_token_encrypted, patientPhone, message);
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

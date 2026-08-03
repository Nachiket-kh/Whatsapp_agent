import { readFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

type WhatsAppMessage = { from?: string; text?: { body?: string } };
type WebhookPayload = {
  entry?: Array<{ changes?: Array<{ value?: { messages?: WhatsAppMessage[] } }> }>;
};

type Draft = { language: string; stage: string; patient_name: string | null; doctor_or_department: string | null; preferred_date: string | null; offered_slots: string[] | null };
const copy = {
  English: { welcome: "Hello 👋 Welcome to ABC Hospital. May I know your name?", doctor: "Which doctor or department would you like to visit?", date: "What date would you prefer? Please reply in YYYY-MM-DD format.", slots: "Available timings are:\n", choose: "Please reply with your preferred time.", confirmed: "Your appointment is confirmed.", unavailable: "Sorry, that time is unavailable. Available timings are:\n" },
  Hindi: { welcome: "नमस्ते 👋 ABC Hospital में आपका स्वागत है। कृपया अपना नाम बताएं?", doctor: "आप किस डॉक्टर या विभाग में जाना चाहते हैं?", date: "आप कौन-सी तारीख पसंद करेंगे? कृपया YYYY-MM-DD में बताएं।", slots: "उपलब्ध समय हैं:\n", choose: "कृपया अपना पसंदीदा समय बताएं।", confirmed: "आपकी अपॉइंटमेंट कन्फर्म हो गई है।", unavailable: "माफ़ कीजिए, यह समय उपलब्ध नहीं है। उपलब्ध समय हैं:\n" },
  Marathi: { welcome: "नमस्कार 👋 ABC Hospital मध्ये आपले स्वागत आहे. कृपया आपले नाव सांगा?", doctor: "आपल्याला कोणत्या डॉक्टरांना किंवा विभागाला भेटायचे आहे?", date: "आपल्याला कोणती तारीख हवी आहे? कृपया YYYY-MM-DD मध्ये सांगा.", slots: "उपलब्ध वेळा आहेत:\n", choose: "कृपया पसंतीची वेळ सांगा.", confirmed: "आपली अपॉइंटमेंट निश्चित झाली आहे.", unavailable: "माफ करा, ही वेळ उपलब्ध नाही. उपलब्ध वेळा आहेत:\n" },
};
type Language = keyof typeof copy;
function languageOf(text: string): Language { if (/ळ|ण्या|आहे|मध्ये/.test(text)) return "Marathi"; if (/[\u0900-\u097F]/.test(text)) return "Hindi"; return "English"; }
function dateOf(text: string) { const matched = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/); if (matched) return matched[1]; if (/tomorrow|कल|उद्या/i.test(text)) { const d = new Date(); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); } return null; }
function timeOf(text: string) { const m = text.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)?\b/i); if (!m) return null; let h = Number(m[1]); if (m[3]?.toUpperCase() === "PM" && h < 12) h += 12; if (m[3]?.toUpperCase() === "AM" && h === 12) h = 0; return `${String(h).padStart(2, "0")}:${m[2]}`; }
function displayTime(value: string) { const [h, m] = value.split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`; }
function showSlots(prefix: string, slots: string[], suffix: string) { return `${prefix}${slots.map((slot) => `• ${displayTime(slot)}`).join("\n")}\n${suffix}`; }

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase service-role environment variables are not configured.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function GET(request: NextRequest) {
  console.log("WhatsApp webhook GET received");
  const search = request.nextUrl.searchParams;
  const mode = search.get("hub.mode");
  const token = search.get("hub.verify_token");
  const challenge = search.get("hub.challenge");
  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN && challenge) {
    return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  console.error("WhatsApp webhook verification failed", { mode, tokenProvided: Boolean(token) });
  return NextResponse.json({ error: "Verification failed" }, { status: 403 });
}

export async function POST(request: NextRequest) {
  console.log("WhatsApp webhook POST received");
  try {
    const payload = (await request.json()) as WebhookPayload;
    const incoming = payload.entry?.flatMap((entry) => entry.changes ?? []).flatMap((change) => change.value?.messages ?? [])[0];
    const phoneNumber = incoming?.from;
    const messageText = incoming?.text?.body?.trim();

    // Meta also posts delivery/read status events. They do not contain a customer message.
    if (!phoneNumber || !messageText) {
      console.log("Webhook callback contained no text message; acknowledging.");
      return NextResponse.json({ ok: true });
    }

    const supabase = serviceClient();
    const now = new Date().toISOString();
    const { data: conversation, error: conversationError } = await supabase
      .from("conversations")
      .upsert({ phone_number: phoneNumber, updated_at: now }, { onConflict: "phone_number" })
      .select("id")
      .single();
    if (conversationError || !conversation) {
      console.error("Supabase conversation upsert failed", { phoneNumber, error: conversationError });
      throw new Error("Unable to create or retrieve conversation.");
    }

    const { error: userMessageError } = await supabase.from("messages").insert({
      conversation_id: conversation.id,
      role: "user",
      content: messageText,
    });
    if (userMessageError) {
      console.error("Supabase user-message insert failed", { conversationId: conversation.id, error: userMessageError });
      throw new Error("Unable to store user message.");
    }

    const { data: savedDraft, error: draftReadError } = await supabase.from("appointment_drafts").select("*").eq("conversation_id", conversation.id).maybeSingle();
    if (draftReadError) console.error("Supabase appointment-draft lookup failed", { conversationId: conversation.id, error: draftReadError });
    let draft = savedDraft as Draft | null;
    let reply: string | undefined;
    const bookingIntent = /appointment|book|doctor|hospital|अपॉइंटमेंट|बुक|डॉक्टर|भेट/i.test(messageText);
    if (!draft && bookingIntent) {
      const language = languageOf(messageText);
      const { error } = await supabase.from("appointment_drafts").upsert({ conversation_id: conversation.id, language, stage: "name" });
      if (error) console.error("Supabase appointment-draft create failed", { conversationId: conversation.id, error });
      reply = copy[language].welcome;
    } else if (draft?.stage === "name") {
      const { data: patient, error: patientError } = await supabase.from("patients").upsert({ phone_number: phoneNumber, full_name: messageText, last_seen: now }, { onConflict: "phone_number" }).select("id").single();
      if (patientError || !patient) { console.error("Supabase patient upsert failed", { phoneNumber, error: patientError }); throw new Error("Unable to save patient."); }
      const { error } = await supabase.from("appointment_drafts").update({ patient_name: messageText, stage: "doctor", updated_at: now }).eq("conversation_id", conversation.id);
      if (error) console.error("Supabase appointment-draft update failed", { conversationId: conversation.id, error });
      reply = copy[draft.language as Language].doctor;
    } else if (draft?.stage === "doctor") {
      const { data: doctors, error } = await supabase.from("doctors").select("id,name,department").eq("enabled", true);
      if (error) console.error("Supabase doctor lookup failed", { error });
      const needle = messageText.toLowerCase();
      const doctor = doctors?.find((item) => item.name.toLowerCase().includes(needle) || item.department.toLowerCase().includes(needle) || needle.includes(item.name.toLowerCase()) || needle.includes(item.department.toLowerCase()));
      if (!doctor) reply = `${copy[draft.language as Language].doctor}\nPlease use a doctor name or available department.`;
      else {
        const { error: updateError } = await supabase.from("appointment_drafts").update({ doctor_or_department: doctor.id, stage: "date", updated_at: now }).eq("conversation_id", conversation.id);
        if (updateError) console.error("Supabase appointment-draft doctor update failed", { conversationId: conversation.id, error: updateError });
        reply = copy[draft.language as Language].date;
      }
    } else if (draft?.stage === "date") {
      const date = dateOf(messageText);
      if (!date) reply = copy[draft.language as Language].date;
      else {
        const { data: doctor, error: doctorError } = await supabase.from("doctors").select("*").eq("id", draft.doctor_or_department!).single();
        if (doctorError || !doctor) { console.error("Supabase selected doctor lookup failed", { error: doctorError }); throw new Error("Selected doctor unavailable."); }
        const { data: booked, error: bookedError } = await supabase.from("appointments").select("appointment_time").eq("doctor_id", doctor.id).eq("appointment_date", date).eq("status", "upcoming");
        if (bookedError) console.error("Supabase appointment-slot lookup failed", { doctorId: doctor.id, date, error: bookedError });
        const busy = new Set((booked ?? []).map((item) => String(item.appointment_time).slice(0, 5)));
        const start = Number(String(doctor.start_time).slice(0, 2)) * 60 + Number(String(doctor.start_time).slice(3, 5)); const end = Number(String(doctor.end_time).slice(0, 2)) * 60 + Number(String(doctor.end_time).slice(3, 5));
        const slots = Array.from({ length: Math.floor((end - start) / doctor.consultation_duration) }, (_, i) => { const t = start + i * doctor.consultation_duration; return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; }).filter((slot) => !busy.has(slot)).slice(0, 3);
        if (!slots.length) reply = "No slots are currently available for this date. Please choose another date.";
        else { const { error: updateError } = await supabase.from("appointment_drafts").update({ preferred_date: date, offered_slots: slots, stage: "time", updated_at: now }).eq("conversation_id", conversation.id); if (updateError) console.error("Supabase appointment-draft slot update failed", { conversationId: conversation.id, error: updateError }); reply = showSlots(copy[draft.language as Language].slots, slots, copy[draft.language as Language].choose); }
      }
    } else if (draft?.stage === "time") {
      const selectedTime = timeOf(messageText);
      const language = draft.language as Language;
      if (!selectedTime || !draft.offered_slots?.includes(selectedTime)) reply = showSlots(copy[language].unavailable, draft.offered_slots ?? [], copy[language].choose);
      else {
        const { data: patient, error: patientError } = await supabase.from("patients").select("id,full_name").eq("phone_number", phoneNumber).single();
        const { data: doctor, error: doctorError } = await supabase.from("doctors").select("id,name,department").eq("id", draft.doctor_or_department!).single();
        if (patientError || doctorError || !patient || !doctor) { console.error("Supabase booking entities lookup failed", { patientError, doctorError }); throw new Error("Unable to create appointment."); }
        const { error: appointmentError } = await supabase.from("appointments").insert({ patient_id: patient.id, conversation_id: conversation.id, doctor_id: doctor.id, patient_name: draft.patient_name ?? patient.full_name ?? "Patient", phone_number: phoneNumber, doctor_name: doctor.name, department: doctor.department, appointment_date: draft.preferred_date, appointment_time: selectedTime });
        if (appointmentError) { console.error("Supabase appointment insert failed", { conversationId: conversation.id, error: appointmentError }); reply = showSlots(copy[language].unavailable, draft.offered_slots ?? [], copy[language].choose); }
        else { const { error } = await supabase.from("appointment_drafts").delete().eq("conversation_id", conversation.id); if (error) console.error("Supabase appointment-draft delete failed", { conversationId: conversation.id, error }); reply = `${copy[language].confirmed}\n${doctor.name} • ${draft.preferred_date} • ${displayTime(selectedTime)}`; }
      }
    }
    if (!reply) {
      const prompt = await readFile(path.join(process.cwd(), "AGENT_PROMPT.md"), "utf8");
      const geminiKey = process.env.GEMINI_API_KEY;
      if (!geminiKey) throw new Error("GEMINI_API_KEY is not configured.");
      const geminiResponse = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent", {
        method: "POST",
        headers: { "x-goog-api-key": geminiKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: prompt }] },
          contents: [{ role: "user", parts: [{ text: messageText }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 350 },
        }),
      });
      if (!geminiResponse.ok) {
        const detail = await geminiResponse.text();
        console.error("Gemini generation failed", { status: geminiResponse.status, detail });
        throw new Error("Gemini could not generate a response.");
      }
      const geminiPayload = await geminiResponse.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
      reply = geminiPayload.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim();
    }
    if (!reply) throw new Error("OpenAI returned an empty response.");

    const { error: assistantMessageError } = await supabase.from("messages").insert({
      conversation_id: conversation.id,
      role: "assistant",
      content: reply,
    });
    if (assistantMessageError) {
      console.error("Supabase assistant-message insert failed", { conversationId: conversation.id, error: assistantMessageError });
      throw new Error("Unable to store assistant response.");
    }

    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    if (!phoneNumberId || !accessToken) throw new Error("WhatsApp Cloud API environment variables are not configured.");
    const whatsappResponse = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: phoneNumber, type: "text", text: { body: reply } }),
    });
    if (!whatsappResponse.ok) {
      const detail = await whatsappResponse.text();
      console.error("WhatsApp Cloud API send failed", { status: whatsappResponse.status, detail });
      throw new Error("Unable to send WhatsApp response.");
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("WhatsApp webhook processing failed", error);
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}

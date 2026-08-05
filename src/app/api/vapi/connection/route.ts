import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { encrypt, secretHash } from "@/lib/crypto";
import { ensureHospital, serviceClient } from "@/lib/hospital";
import { createClient } from "@/lib/supabase/server";
export const runtime = "nodejs";
async function hospital() { const auth = await createClient(); const { data:{ user } } = await auth.auth.getUser(); if (!user) throw new Error("Unauthorized"); return ensureHospital(user.id); }
type VapiAssistant = { model?: Record<string, unknown>; [key: string]: unknown };
const appointmentFunctions = [
  ["listDoctors", "Get the currently enabled doctors and departments before offering choices.", {}],
  ["getHospitalInfo", "Get hospital hours, departments, emergency number, or other hospital FAQs.", {}],
  ["getAvailableSlots", "Get real unbooked appointment slots after the patient chooses a doctor and date.", { doctorId: { type: "string", description: "Selected doctor ID" }, date: { type: "string", description: "Appointment date in YYYY-MM-DD format" } }, ["doctorId", "date"]],
  ["bookAppointment", "Create an appointment only after the patient clearly confirms all details.", { patientName: { type: "string" }, phoneNumber: { type: "string" }, doctorId: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD" }, time: { type: "string", description: "HH:MM 24-hour time" }, reason: { type: "string", description: "Reason for visit" } }, ["patientName", "phoneNumber", "doctorId", "date", "time"]],
  ["checkAppointmentStatus", "Look up appointments for a patient phone number.", { phoneNumber: { type: "string" } }, ["phoneNumber"]],
  ["cancelAppointment", "Cancel the specific appointment identified by appointmentId after confirmation.", { appointmentId: { type: "string" } }, ["appointmentId"]],
  ["rescheduleAppointment", "Explain the safe rescheduling sequence: check booking, select new slot, then create the new confirmed appointment.", { appointmentId: { type: "string" } }, ["appointmentId"]],
].map(([name, description, properties, required]) => ({ name, description, parameters: { type: "object", properties, required: required ?? [] }, async: false }));
function systemPrompt(greeting: string) { return `You are ABC Hospital's AI voice receptionist. Start in Marathi: ${greeting} If the caller prefers Hindi or English, switch immediately. Collect name, phone number, reason for visit, doctor, date, and time. Use listDoctors before suggesting doctors; use getAvailableSlots before offering slots; use bookAppointment only after the patient confirms every detail. Never invent doctors, availability, dates, or bookings. Use checkAppointmentStatus and cancelAppointment when requested. For emergencies, direct the caller to emergency services. Do not diagnose or prescribe.`; }
async function configureVapi(apiKey: string, assistantId: string, serverUrl: string, greeting: string) {
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const read = await fetch(`https://api.vapi.ai/assistant/${encodeURIComponent(assistantId)}`, { headers });
  if (!read.ok) throw new Error(`Vapi could not read this Assistant (${read.status}). Check the Private API key and Assistant ID.`);
  const assistant = await read.json() as VapiAssistant;
  const model = { ...(assistant.model ?? {}) };
  const existingFunctions = Array.isArray(model.functions) ? model.functions as Array<{ name?: string }> : [];
  model.functions = [...existingFunctions.filter((item) => !appointmentFunctions.some((tool) => tool.name === item.name)), ...appointmentFunctions];
  const existingMessages = Array.isArray(model.messages) ? model.messages as Array<{ role?: string; content?: string }> : [];
  model.messages = [{ role: "system", content: systemPrompt(greeting) }, ...existingMessages.filter((message) => message.role !== "system")];
  const update = await fetch(`https://api.vapi.ai/assistant/${encodeURIComponent(assistantId)}`, { method: "PATCH", headers, body: JSON.stringify({ model, firstMessage: greeting, firstMessageMode: "assistant-speaks-first", server: { url: serverUrl, timeoutSeconds: 20 }, serverMessages: ["tool-calls", "function-call", "end-of-call-report", "status-update"] }) });
  if (!update.ok) throw new Error(`Vapi Assistant setup failed (${update.status}): ${await update.text()}`);
}
export async function GET() { try { const hospitalId=await hospital(); const {data,error}=await serviceClient().from("vapi_connections").select("assistant_id,phone_number_id,default_language,greeting,enabled,updated_at").eq("hospital_id",hospitalId).maybeSingle(); if(error) throw error; return NextResponse.json({connection:data,hospitalId}); } catch(error) { return NextResponse.json({error:error instanceof Error?error.message:"Unable to load Vapi settings."},{status:401}); } }
export async function POST(request:NextRequest) { try { const hospitalId=await hospital(); const body=await request.json() as {apiKey?:string;assistantId?:string;phoneNumberId?:string;defaultLanguage?:string;greeting?:string;enabled?:boolean}; if(!body.apiKey?.trim()||!body.assistantId?.trim()) return NextResponse.json({error:"Vapi API key and Assistant ID are required."},{status:400}); const secret=randomBytes(32).toString("base64url"); const origin=process.env.NEXT_PUBLIC_APP_URL??request.nextUrl.origin; const serverUrl=`${origin}/api/vapi/webhook/${hospitalId}?token=${secret}`; const greeting=body.greeting?.trim()||"नमस्कार! ABC हॉस्पिटलमध्ये आपले स्वागत आहे. अपॉइंटमेंट बुक करण्यासाठी कृपया आपले पूर्ण नाव सांगा."; await configureVapi(body.apiKey.trim(),body.assistantId.trim(),serverUrl,greeting); const {error}=await serviceClient().from("vapi_connections").upsert({hospital_id:hospitalId,api_key_encrypted:encrypt(body.apiKey.trim()),assistant_id:body.assistantId.trim(),phone_number_id:body.phoneNumberId?.trim()||null,default_language:"Marathi",greeting,enabled:body.enabled!==false,webhook_secret_hash:secretHash(secret),updated_at:new Date().toISOString()},{onConflict:"hospital_id"}); if(error) throw error; return NextResponse.json({ok:true,serverUrl}); } catch(error) { console.error("Vapi connection setup failed",error); return NextResponse.json({error:error instanceof Error?error.message:"Unable to save Vapi settings."},{status:500}); } }

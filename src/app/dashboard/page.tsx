import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import DashboardClient from "./dashboard-client";
import type { Appointment, Conversation, Doctor, HospitalSettings, Message, Patient } from "@/lib/database.types";
import { ensureHospital, serviceClient } from "@/lib/hospital";
import { cleanupExpiredChats } from "@/lib/chat-retention";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const hospitalId = await ensureHospital(user.id);
  // Ensure the configured chat/contact retention window is applied whenever
  // an administrator opens the dashboard.
  try { await cleanupExpiredChats(hospitalId); } catch (error) { console.error("Dashboard chat retention cleanup failed", error); }
  // The user is authenticated above and hospitalId is resolved from their
  // membership. Use the server service client for these reads so dashboard
  // updates written by the Meta webhook are visible even on older RLS setups.
  const db = serviceClient();
  const { data: conversations } = await db.from("conversations").select("*").eq("hospital_id", hospitalId).order("updated_at", { ascending: false });
  const conversationIds = (conversations ?? []).map((conversation) => conversation.id);
  const { data: messages } = conversationIds.length ? await db.from("messages").select("*").in("conversation_id", conversationIds).order("created_at", { ascending: true }) : { data: [] };
  const [{ data: appointments }, { data: doctors }, { data: patients }, { data: settings }] = await Promise.all([
    db.from("appointments").select("*").eq("hospital_id", hospitalId).order("appointment_date").order("appointment_time"), db.from("doctors").select("*").eq("hospital_id", hospitalId).order("name"), db.from("patients").select("*").eq("hospital_id", hospitalId).order("last_seen", { ascending: false }), db.from("hospital_settings").select("*").eq("hospital_id", hospitalId).maybeSingle(),
  ]);
  return <DashboardClient hospitalId={hospitalId} initialConversations={(conversations ?? []) as Conversation[]} initialMessages={(messages ?? []) as Message[]} initialAppointments={(appointments ?? []) as Appointment[]} initialDoctors={(doctors ?? []) as Doctor[]} initialPatients={(patients ?? []) as Patient[]} initialSettings={settings as HospitalSettings | null} />;
}

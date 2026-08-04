import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import DashboardClient from "./dashboard-client";
import type { Appointment, Conversation, Doctor, HospitalSettings, Message, Patient } from "@/lib/database.types";
import { ensureHospital } from "@/lib/hospital";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const hospitalId = await ensureHospital(user.id);
  const { data: conversations } = await supabase.from("conversations").select("*").eq("hospital_id", hospitalId).order("updated_at", { ascending: false });
  const conversationIds = (conversations ?? []).map((conversation) => conversation.id);
  const { data: messages } = conversationIds.length ? await supabase.from("messages").select("*").in("conversation_id", conversationIds).order("created_at", { ascending: true }) : { data: [] };
  const [{ data: appointments }, { data: doctors }, { data: patients }, { data: settings }] = await Promise.all([
    supabase.from("appointments").select("*").eq("hospital_id", hospitalId).order("appointment_date"), supabase.from("doctors").select("*").eq("hospital_id", hospitalId).order("name"), supabase.from("patients").select("*").eq("hospital_id", hospitalId).order("last_seen", { ascending: false }), supabase.from("hospital_settings").select("*").eq("hospital_id", hospitalId).maybeSingle(),
  ]);
  return <DashboardClient hospitalId={hospitalId} initialConversations={(conversations ?? []) as Conversation[]} initialMessages={(messages ?? []) as Message[]} initialAppointments={(appointments ?? []) as Appointment[]} initialDoctors={(doctors ?? []) as Doctor[]} initialPatients={(patients ?? []) as Patient[]} initialSettings={settings as HospitalSettings | null} />;
}

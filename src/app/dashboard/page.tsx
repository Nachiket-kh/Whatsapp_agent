import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import DashboardClient from "./dashboard-client";
import type { Appointment, Conversation, Doctor, HospitalSettings, Message, Patient } from "@/lib/database.types";

export default async function DashboardPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  const { data: conversations } = await supabase.from("conversations").select("*").order("updated_at", { ascending: false });
  const { data: messages } = await supabase.from("messages").select("*").order("created_at", { ascending: true });
  const [{ data: appointments }, { data: doctors }, { data: patients }, { data: settings }] = await Promise.all([
    supabase.from("appointments").select("*").order("appointment_date"), supabase.from("doctors").select("*").order("name"), supabase.from("patients").select("*").order("last_seen", { ascending: false }), supabase.from("hospital_settings").select("*").eq("id", 1).maybeSingle(),
  ]);
  return <DashboardClient initialConversations={(conversations ?? []) as Conversation[]} initialMessages={(messages ?? []) as Message[]} initialAppointments={(appointments ?? []) as Appointment[]} initialDoctors={(doctors ?? []) as Doctor[]} initialPatients={(patients ?? []) as Patient[]} initialSettings={settings as HospitalSettings | null} />;
}

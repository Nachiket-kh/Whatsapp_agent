import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ensureHospital } from "@/lib/hospital";
import VoiceSettings from "./voice-settings";

export default async function VoicePage() {
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) redirect("/login");
  const hospitalId = await ensureHospital(user.id);
  const { data: connection } = await auth.from("voice_agent_connections").select("agent_id,phone_number,enabled,updated_at").eq("hospital_id", hospitalId).maybeSingle();
  const { data: calls } = await auth.from("voice_call_logs").select("id,caller_phone,status,ended_at,created_at").eq("hospital_id", hospitalId).order("created_at", { ascending: false }).limit(12);
  return <VoiceSettings initialConnection={connection} initialCalls={calls ?? []} />;
}

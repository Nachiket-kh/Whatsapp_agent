import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { ensureHospital } from "@/lib/hospital";
import VoiceSettings from "./voice-settings";
export default async function VoicePage(){const auth=await createClient();const {data:{user}}=await auth.auth.getUser();if(!user)redirect("/login");const hospitalId=await ensureHospital(user.id);const [{data:connection},{data:calls}]=await Promise.all([auth.from("vapi_connections").select("assistant_id,phone_number_id,default_language,greeting,enabled,updated_at").eq("hospital_id",hospitalId).maybeSingle(),auth.from("vapi_call_logs").select("id,caller_phone,status,booking_status,duration_seconds,created_at").eq("hospital_id",hospitalId).order("created_at",{ascending:false}).limit(15)]);return <VoiceSettings initialConnection={connection} initialCalls={calls??[]}/>;}

import { redirect } from "next/navigation";
import { serviceClient } from "@/lib/hospital";
import { hasDashboardSession, requireDashboardHospital } from "@/lib/app-auth";
import VoiceSettings from "./voice-settings";
export default async function VoicePage(){if(!await hasDashboardSession())redirect("/login");const hospitalId=await requireDashboardHospital();const db=serviceClient();const [{data:connection},{data:calls}]=await Promise.all([db.from("vapi_connections").select("assistant_id,phone_number_id,default_language,greeting,enabled,updated_at").eq("hospital_id",hospitalId).maybeSingle(),db.from("vapi_call_logs").select("id,caller_phone,status,booking_status,duration_seconds,created_at").eq("hospital_id",hospitalId).order("created_at",{ascending:false}).limit(15)]);return <VoiceSettings initialConnection={connection} initialCalls={calls??[]}/>;}

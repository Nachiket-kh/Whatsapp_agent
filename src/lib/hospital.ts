import { createClient } from "@supabase/supabase-js";

export function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase service-role environment variables are not configured.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function ensureHospital(userId: string) {
  const supabase = serviceClient();
  const { data: membership, error } = await supabase.from("hospital_members").select("hospital_id").eq("user_id", userId).limit(1).maybeSingle();
  if (error) throw error;
  if (membership) return membership.hospital_id as string;
  const { data: hospital, error: hospitalError } = await supabase.from("hospitals").insert({ name: "ABC Hospital", owner_id: userId }).select("id").single();
  if (hospitalError || !hospital) throw hospitalError ?? new Error("Could not create hospital.");
  const { error: memberError } = await supabase.from("hospital_members").insert({ hospital_id: hospital.id, user_id: userId, role: "admin" });
  if (memberError) throw memberError;
  return hospital.id as string;
}

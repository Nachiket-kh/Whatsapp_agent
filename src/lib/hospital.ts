import { createClient } from "@supabase/supabase-js";

export function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase service-role environment variables are not configured.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function ensureHospital(userId: string) {
  const supabase = serviceClient();
  const { data: memberships, error } = await supabase.from("hospital_members").select("hospital_id").eq("user_id", userId);
  if (error) throw error;
  if (memberships?.length) {
    // A user can have legacy/demo hospitals. Always open the hospital that owns
    // their active WhatsApp connection so incoming bookings appear immediately.
    const ids = memberships.map((membership) => membership.hospital_id);
    const { data: connection, error: connectionError } = await supabase.from("evolution_connections").select("hospital_id").in("hospital_id", ids).order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (connectionError) throw connectionError;
    return (connection?.hospital_id ?? memberships[0].hospital_id) as string;
  }
  const { data: hospital, error: hospitalError } = await supabase.from("hospitals").insert({ name: "ABC Hospital", owner_id: userId }).select("id").single();
  if (hospitalError || !hospital) throw hospitalError ?? new Error("Could not create hospital.");
  const { error: memberError } = await supabase.from("hospital_members").insert({ hospital_id: hospital.id, user_id: userId, role: "admin" });
  if (memberError) throw memberError;
  return hospital.id as string;
}

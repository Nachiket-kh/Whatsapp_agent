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
    // A user can have legacy/demo hospitals. Prefer the hospital attached to
    // their most recently configured communication channel so both WhatsApp
    // and voice bookings appear in the same dashboard.
    const ids = memberships.map((membership) => membership.hospital_id);
    const [evolutionResult, vapiResult] = await Promise.all([
      supabase.from("evolution_connections").select("hospital_id, updated_at").in("hospital_id", ids),
      supabase.from("vapi_connections").select("hospital_id, updated_at").in("hospital_id", ids),
    ]);

    if (evolutionResult.error) throw evolutionResult.error;
    // Older installations may not have run the Vapi migration yet. In that
    // case continue using the WhatsApp connection instead of blocking login.
    if (vapiResult.error && !["42P01", "PGRST205"].includes(vapiResult.error.code ?? "")) {
      console.error("Could not load Vapi hospital connection", vapiResult.error);
    }

    const activeConnections = [
      ...(evolutionResult.data ?? []),
      ...(vapiResult.data ?? []),
    ].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

    return (activeConnections[0]?.hospital_id ?? memberships[0].hospital_id) as string;
  }
  const { data: hospital, error: hospitalError } = await supabase.from("hospitals").insert({ name: "ABC Hospital", owner_id: userId }).select("id").single();
  if (hospitalError || !hospital) throw hospitalError ?? new Error("Could not create hospital.");
  const { error: memberError } = await supabase.from("hospital_members").insert({ hospital_id: hospital.id, user_id: userId, role: "admin" });
  if (memberError) throw memberError;
  return hospital.id as string;
}

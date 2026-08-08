import { serviceClient } from "@/lib/hospital";

const cleanupTimes = new Map<string, number>();

export async function cleanupExpiredChats(hospitalId: string) {
  const db = serviceClient();
  let retentionHours = 24;
  const { data: settings, error: settingsError } = await db
    .from("hospital_settings")
    .select("chat_retention_hours")
    .eq("hospital_id", hospitalId)
    .maybeSingle();

  // Existing installations continue with the safe 24-hour default until the
  // schema migration is run.
  if (settingsError) console.warn("Chat retention setting is unavailable; using the 24-hour default.", settingsError.code);
  else if (typeof settings?.chat_retention_hours === "number") retentionHours = Math.min(720, Math.max(1, settings.chat_retention_hours));

  const cutoff = new Date(Date.now() - retentionHours * 60 * 60 * 1000).toISOString();
  const { data: conversations, error: conversationError } = await db
    .from("conversations")
    .select("id,phone_number")
    .eq("hospital_id", hospitalId)
    .lt("updated_at", cutoff)
    .limit(500);
  if (conversationError) throw conversationError;
  if (!conversations?.length) return { deletedChats: 0, deletedContacts: 0, retentionHours };

  const conversationIds = conversations.map((conversation) => conversation.id);
  const phones = [...new Set(conversations.map((conversation) => conversation.phone_number))];
  const [{ error: draftsError }, { error: messagesError }, { error: deleteConversationsError }, { data: appointments, error: appointmentsError }] = await Promise.all([
    db.from("appointment_drafts").delete().in("conversation_id", conversationIds),
    db.from("messages").delete().in("conversation_id", conversationIds),
    db.from("conversations").delete().in("id", conversationIds).eq("hospital_id", hospitalId),
    db.from("appointments").select("phone_number").eq("hospital_id", hospitalId).in("phone_number", phones),
  ]);
  if (draftsError || messagesError || deleteConversationsError || appointmentsError) throw draftsError ?? messagesError ?? deleteConversationsError ?? appointmentsError;

  // Never delete a patient linked to an appointment: bookings and clinical
  // dashboard records remain intact even when their chat is retained only 24h.
  const appointmentPhones = new Set((appointments ?? []).map((appointment) => appointment.phone_number));
  const removablePhones = phones.filter((phone) => !appointmentPhones.has(phone));
  let deletedContacts = 0;
  if (removablePhones.length) {
    const { data: deletedPatients, error: patientError } = await db.from("patients")
      .delete().eq("hospital_id", hospitalId).in("phone_number", removablePhones).select("id");
    if (patientError) throw patientError;
    deletedContacts = deletedPatients?.length ?? 0;
  }
  return { deletedChats: conversationIds.length, deletedContacts, retentionHours };
}

export async function cleanupExpiredChatsWhenDue(hospitalId: string) {
  const lastRun = cleanupTimes.get(hospitalId) ?? 0;
  if (Date.now() - lastRun < 15 * 60 * 1000) return;
  cleanupTimes.set(hospitalId, Date.now());
  try {
    await cleanupExpiredChats(hospitalId);
  } catch (error) {
    console.error("Automatic chat retention cleanup failed", error);
  }
}

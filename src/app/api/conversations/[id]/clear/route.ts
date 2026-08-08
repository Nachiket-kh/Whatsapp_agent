import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ensureHospital, serviceClient } from "@/lib/hospital";

export async function POST(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const hospitalId = await ensureHospital(user.id);
  const db = serviceClient();
  const { data: conversation, error: conversationError } = await db.from("conversations").select("id").eq("id", id).eq("hospital_id", hospitalId).maybeSingle();
  if (conversationError || !conversation) return NextResponse.json({ error: "Conversation was not found." }, { status: 404 });
  const [{ error: draftError }, { error: messageError }] = await Promise.all([
    db.from("appointment_drafts").delete().eq("conversation_id", id),
    db.from("messages").delete().eq("conversation_id", id),
  ]);
  if (draftError || messageError) {
    console.error("Dashboard chat clear failed", draftError ?? messageError);
    return NextResponse.json({ error: "Unable to clear this chat." }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const hospitalId = await ensureHospital(user.id);
  const db = serviceClient();
  const { data: conversation, error: conversationError } = await db.from("conversations")
    .select("id,phone_number").eq("id", id).eq("hospital_id", hospitalId).maybeSingle();
  if (conversationError || !conversation) return NextResponse.json({ error: "Conversation was not found." }, { status: 404 });

  const [{ error: draftError }, { error: messageError }, { error: conversationDeleteError }, { data: appointments, error: appointmentsError }] = await Promise.all([
    db.from("appointment_drafts").delete().eq("conversation_id", id),
    db.from("messages").delete().eq("conversation_id", id),
    db.from("conversations").delete().eq("id", id).eq("hospital_id", hospitalId),
    db.from("appointments").select("id").eq("hospital_id", hospitalId).eq("phone_number", conversation.phone_number).limit(1),
  ]);
  if (draftError || messageError || conversationDeleteError || appointmentsError) {
    console.error("Dashboard contact deletion failed", draftError ?? messageError ?? conversationDeleteError ?? appointmentsError);
    return NextResponse.json({ error: "Unable to delete this contact." }, { status: 500 });
  }

  let patientDeleted = false;
  if (!appointments?.length) {
    const { error: patientError } = await db.from("patients").delete()
      .eq("hospital_id", hospitalId).eq("phone_number", conversation.phone_number);
    if (patientError) {
      console.error("Dashboard patient deletion failed", patientError);
      return NextResponse.json({ error: "Chat deleted, but the patient contact could not be deleted." }, { status: 500 });
    }
    patientDeleted = true;
  }
  return NextResponse.json({ ok: true, patientDeleted });
}

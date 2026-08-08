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

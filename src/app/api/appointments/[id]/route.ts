import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ensureHospital, serviceClient } from "@/lib/hospital";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const hospitalId = await ensureHospital(user.id);
  const body = await request.json() as { status?: "upcoming" | "completed" | "cancelled" };
  if (!body.status || !["upcoming", "completed", "cancelled"].includes(body.status)) return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  const db = serviceClient();
  const { data, error } = await db.from("appointments").update({ status: body.status }).eq("id", id).eq("hospital_id", hospitalId).select("*").single();
  if (error || !data) { console.error("Dashboard appointment update failed", error); return NextResponse.json({ error: error?.message ?? "Appointment was not found" }, { status: 404 }); }
  if (body.status === "completed" && data.conversation_id) {
    const [{ error: draftError }, { error: messagesError }] = await Promise.all([
      db.from("appointment_drafts").delete().eq("conversation_id", data.conversation_id),
      db.from("messages").delete().eq("conversation_id", data.conversation_id),
    ]);
    if (draftError || messagesError) console.error("Completed appointment chat cleanup failed", draftError ?? messagesError);
  }
  return NextResponse.json({ appointment: data, chatCleared: body.status === "completed" && Boolean(data.conversation_id) });
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const auth = await createClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const hospitalId = await ensureHospital(user.id);
  const { error } = await serviceClient().from("appointments").delete().eq("id", id).eq("hospital_id", hospitalId);
  if (error) { console.error("Dashboard appointment delete failed", error); return NextResponse.json({ error: error.message }, { status: 400 }); }
  return NextResponse.json({ ok: true });
}

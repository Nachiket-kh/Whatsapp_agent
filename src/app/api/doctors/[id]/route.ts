import { NextRequest, NextResponse } from "next/server";
import { requireDashboardHospital } from "@/lib/app-auth";
import { serviceClient } from "@/lib/hospital";

export const runtime = "nodejs";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json() as { enabled?: boolean };
  if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled must be true or false." }, { status: 400 });
  try {
    const hospitalId = await requireDashboardHospital();
    const { data, error } = await serviceClient().from("doctors").update({ enabled: body.enabled }).eq("id", id).eq("hospital_id", hospitalId).select("id,name,department,enabled,working_days,start_time,end_time,consultation_duration").single();
    if (error || !data) { console.error("Doctor availability update failed", error); return NextResponse.json({ error: error?.message ?? "Doctor was not found." }, { status: 404 }); }
    return NextResponse.json({ doctor: data });
  } catch (error) {
    console.error("Doctor availability update failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update doctor availability." }, { status: 500 });
  }
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const hospitalId = await requireDashboardHospital();
    const { error, count } = await serviceClient()
      .from("doctors")
      .delete({ count: "exact" })
      .eq("id", id)
      .eq("hospital_id", hospitalId);
    if (error) {
      console.error("Doctor deletion failed", error);
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    if (!count) return NextResponse.json({ error: "Doctor was not found." }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Doctor deletion failed", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to delete doctor." }, { status: 500 });
  }
}

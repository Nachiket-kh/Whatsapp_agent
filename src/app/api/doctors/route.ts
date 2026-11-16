import { NextRequest, NextResponse } from "next/server";
import { requireDashboardHospital } from "@/lib/app-auth";
import { serviceClient } from "@/lib/hospital";

export async function POST(request: NextRequest) {
  try {
    const hospitalId = await requireDashboardHospital();
    const body = await request.json() as { name?: string; department?: string };
    const name = String(body.name ?? "").trim();
    const department = String(body.department ?? "").trim();
    if (name.length < 2 || department.length < 2) return NextResponse.json({ error: "Enter a valid doctor name and department." }, { status: 400 });
    const { data, error } = await serviceClient().from("doctors").insert({ hospital_id: hospitalId, name, department }).select("*").single();
    if (error) throw error;
    return NextResponse.json({ doctor: data });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to add doctor." }, { status: 500 });
  }
}

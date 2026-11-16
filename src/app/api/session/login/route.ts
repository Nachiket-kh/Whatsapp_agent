import { NextRequest, NextResponse } from "next/server";
import { APP_SESSION_COOKIE, createDashboardSession, dashboardSessionCookie, validateAdminLogin } from "@/lib/app-auth";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as { email?: string; password?: string };
    if (!validateAdminLogin(String(body.email ?? ""), String(body.password ?? ""))) {
      return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
    }
    const response = NextResponse.json({ ok: true });
    response.cookies.set(APP_SESSION_COOKIE, createDashboardSession(), dashboardSessionCookie());
    return response;
  } catch (error) {
    console.error("Dashboard login failed", error);
    return NextResponse.json({ error: "Dashboard login is not configured." }, { status: 503 });
  }
}

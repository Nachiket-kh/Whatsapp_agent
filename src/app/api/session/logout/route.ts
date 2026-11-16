import { NextResponse } from "next/server";
import { APP_SESSION_COOKIE } from "@/lib/app-auth";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(APP_SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return response;
}

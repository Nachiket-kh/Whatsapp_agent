import { NextRequest, NextResponse } from "next/server";
import { hasDashboardSession, requireDashboardHospital } from "@/lib/app-auth";
import { createMetaOAuthState, metaRedirectUri } from "@/lib/meta-oauth";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  if (!await hasDashboardSession()) return NextResponse.redirect(new URL("/login", request.url));
  if (!process.env.META_APP_ID || !process.env.META_APP_SECRET || !process.env.META_WEBHOOK_VERIFY_TOKEN) {
    return NextResponse.redirect(new URL("/whatsapp?meta=missing-config", request.url));
  }
  const state = createMetaOAuthState(await requireDashboardHospital());
  const query = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: metaRedirectUri(request.nextUrl.origin),
    state,
    response_type: "code",
    scope: "business_management,whatsapp_business_management,whatsapp_business_messaging",
  });
  const response = NextResponse.redirect(`https://www.facebook.com/v22.0/dialog/oauth?${query.toString()}`);
  response.cookies.set("meta_oauth_state", state, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: 600, path: "/" });
  return response;
}

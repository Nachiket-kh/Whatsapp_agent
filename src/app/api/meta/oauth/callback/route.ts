import { NextRequest, NextResponse } from "next/server";
import { encrypt, secretHash } from "@/lib/crypto";
import { verifyMetaOAuthState, metaRedirectUri } from "@/lib/meta-oauth";
import { serviceClient } from "@/lib/hospital";

export const runtime = "nodejs";

type Phone = { id?: string; display_phone_number?: string; verified_name?: string };
type Account = { id?: string; name?: string; phone_numbers?: { data?: Phone[] } | Phone[] };

function finish(request: NextRequest, result: string) {
  const response = NextResponse.redirect(new URL(`/whatsapp?meta=${encodeURIComponent(result)}`, request.url));
  response.cookies.delete("meta_oauth_state");
  return response;
}

export async function GET(request: NextRequest) {
  try {
    const denied = request.nextUrl.searchParams.get("error");
    if (denied) return finish(request, "cancelled");
    const code = request.nextUrl.searchParams.get("code");
    const state = request.nextUrl.searchParams.get("state");
    const savedState = request.cookies.get("meta_oauth_state")?.value;
    if (!code || !state || state !== savedState) return finish(request, "invalid-state");
    const payload = verifyMetaOAuthState(state);
    if (!payload || !process.env.META_APP_ID || !process.env.META_APP_SECRET || !process.env.META_WEBHOOK_VERIFY_TOKEN) return finish(request, "missing-config");

    const redirectUri = metaRedirectUri(request.nextUrl.origin);
    const exchange = new URL("https://graph.facebook.com/v22.0/oauth/access_token");
    exchange.search = new URLSearchParams({ client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, redirect_uri: redirectUri, code }).toString();
    const exchanged = await fetch(exchange);
    if (!exchanged.ok) { console.error("Meta OAuth code exchange failed", await exchanged.text()); return finish(request, "token-exchange-failed"); }
    const firstToken = await exchanged.json() as { access_token?: string };
    if (!firstToken.access_token) return finish(request, "token-exchange-failed");

    const longLived = new URL("https://graph.facebook.com/v22.0/oauth/access_token");
    longLived.search = new URLSearchParams({ grant_type: "fb_exchange_token", client_id: process.env.META_APP_ID, client_secret: process.env.META_APP_SECRET, fb_exchange_token: firstToken.access_token }).toString();
    const refreshed = await fetch(longLived);
    const token = refreshed.ok ? ((await refreshed.json() as { access_token?: string }).access_token || firstToken.access_token) : firstToken.access_token;

    const accountsResponse = await fetch("https://graph.facebook.com/v22.0/me/whatsapp_business_accounts?fields=id,name,phone_numbers{id,display_phone_number,verified_name}", { headers: { Authorization: `Bearer ${token}` } });
    if (!accountsResponse.ok) { console.error("Meta OAuth account lookup failed", await accountsResponse.text()); return finish(request, "account-lookup-failed"); }
    const accounts = (await accountsResponse.json() as { data?: Account[] }).data ?? [];
    const account = accounts.find((candidate) => candidate.id && candidate.phone_numbers);
    const phones = Array.isArray(account?.phone_numbers) ? account.phone_numbers : account?.phone_numbers?.data ?? [];
    const phone = phones.find((candidate) => candidate.id);
    if (!account?.id || !phone?.id) return finish(request, "no-whatsapp-number");

    const { error } = await serviceClient().from("meta_connections").upsert({
      hospital_id: payload.hospitalId,
      whatsapp_business_account_id: account.id,
      phone_number_id: phone.id,
      display_phone_number: phone.display_phone_number || phone.verified_name || null,
      access_token_encrypted: encrypt(token),
      verify_token_hash: secretHash(process.env.META_WEBHOOK_VERIFY_TOKEN),
      connection_source: "oauth",
      status: "connected",
      last_error: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "hospital_id" });
    if (error) { console.error("Meta OAuth connection write failed", error); return finish(request, "database-failed"); }
    return finish(request, "connected");
  } catch (error) { console.error("Meta OAuth callback failed", error); return finish(request, "failed"); }
}

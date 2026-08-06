import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

type OAuthState = { hospitalId: string; nonce: string; expiresAt: number };

function signingKey() {
  const value = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!value) throw new Error("CREDENTIALS_ENCRYPTION_KEY is not configured.");
  return value;
}

export function metaRedirectUri(origin?: string) {
  return process.env.META_REDIRECT_URI || `${origin}/api/meta/oauth/callback`;
}

export function createMetaOAuthState(hospitalId: string) {
  const payload: OAuthState = { hospitalId, nonce: randomUUID(), expiresAt: Date.now() + 10 * 60 * 1000 };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", signingKey()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function verifyMetaOAuthState(value: string | undefined) {
  if (!value) return null;
  const [encoded, signature] = value.split(".");
  if (!encoded || !signature) return null;
  const expected = createHmac("sha256", signingKey()).update(encoded).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as OAuthState;
    if (!payload.hospitalId || !payload.nonce || payload.expiresAt < Date.now()) return null;
    return payload;
  } catch { return null; }
}

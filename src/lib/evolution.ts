import { decrypt } from "@/lib/crypto";

export type EvolutionConnection = { server_url: string; instance_name: string; api_key_encrypted: string };
export function normaliseServerUrl(value: string) { return value.replace(/\/+$/, ""); }

export async function evolutionRequest(connection: EvolutionConnection, endpoint: string, init: RequestInit = {}) {
  const response = await fetch(`${normaliseServerUrl(connection.server_url)}${endpoint}`, {
    ...init,
    headers: { apikey: decrypt(connection.api_key_encrypted), "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const raw = await response.text();
  let body: unknown = raw;
  try { body = raw ? JSON.parse(raw) : {}; } catch { /* provider may return plain text */ }
  if (!response.ok) throw new Error(`Evolution API ${response.status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  return body as Record<string, unknown>;
}

export function extractQr(body: Record<string, unknown>) {
  const qrcode = body.qrcode as { base64?: string; code?: string } | undefined;
  const nested = (body.base64 ?? (body.instance as { qrcode?: string } | undefined)?.qrcode) as string | undefined;
  return qrcode?.base64 ?? nested ?? qrcode?.code ?? null;
}

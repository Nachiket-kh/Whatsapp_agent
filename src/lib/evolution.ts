import { decrypt } from "@/lib/crypto";

export type EvolutionConnection = { server_url: string; instance_name: string; api_key_encrypted: string };
/** The Evolution Manager is a UI, while API requests must target the API root. */
export function normaliseServerUrl(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); } catch {
    throw new Error("Enter a complete Evolution API URL, for example https://your-server.example.com.");
  }
  // Cloud Station prominently displays this Manager URL; accept it safely.
  if (url.pathname === "/manager" || url.pathname.startsWith("/manager/")) url.pathname = "/";
  if (url.hostname.endsWith(".cloud-station.app") && url.protocol === "http:") url.protocol = "https:";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

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

export function connectionStatusFromProvider(body: Record<string, unknown>) {
  const instance = body.instance as Record<string, unknown> | undefined;
  const raw = instance?.state ?? body.state ?? body.connectionStatus ?? body.status;
  if (typeof raw !== "string") return null;
  const state = raw.toLowerCase();
  if (["open", "connected"].includes(state)) return "connected" as const;
  if (["close", "closed", "disconnected", "logout"].includes(state)) return "disconnected" as const;
  return "connecting" as const;
}

export function extractQr(body: Record<string, unknown>) {
  const qrcode = body.qrcode as { base64?: string; code?: string } | undefined;
  const nested = (body.base64 ?? (body.instance as { qrcode?: string } | undefined)?.qrcode) as string | undefined;
  return qrcode?.base64 ?? nested ?? qrcode?.code ?? null;
}

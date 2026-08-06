import { decrypt } from "@/lib/crypto";

export type EvolutionConnection = { server_url_encrypted: string; api_key_encrypted: string; instance_name: string };

export function evolutionUrl(baseUrl: string, pathname: string) {
  return `${baseUrl.trim().replace(/\/+$/, "")}/${pathname.replace(/^\/+/, "")}`;
}

export async function evolutionRequest(connection: EvolutionConnection, pathname: string, init: RequestInit = {}) {
  return fetch(evolutionUrl(decrypt(connection.server_url_encrypted), pathname), {
    ...init,
    headers: { apikey: decrypt(connection.api_key_encrypted), "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

export function readEvolutionState(payload: unknown) {
  const record = payload as { instance?: { state?: string } | string; state?: string };
  const instanceState = typeof record?.instance === "object" ? record.instance?.state : undefined;
  const state = instanceState ?? record?.state ?? "";
  return String(state).toLowerCase() === "open" ? "connected" : String(state).toLowerCase() === "connecting" ? "qr_pending" : "disconnected";
}

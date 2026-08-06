"use client";
import { useEffect, useState } from "react";

type Connection = { phone_number_id: string; display_phone_number: string | null; status: "connected" | "disconnected"; last_error: string | null; updated_at: string };

const oauthMessages: Record<string, string> = {
  connected: "Meta account connected successfully. Your WhatsApp booking agent is ready.",
  cancelled: "Meta connection was cancelled.",
  "missing-config": "The server needs Meta OAuth environment variables before it can connect.",
  "invalid-state": "The Meta connection session expired. Please try Connect with Meta again.",
  "token-exchange-failed": "Meta did not accept the authorization code. Please try again.",
  "account-lookup-failed": "Meta could not read the WhatsApp Business account. Check app permissions and asset access.",
  "no-whatsapp-number": "No WhatsApp phone number was found for this Meta account.",
  "database-failed": "Meta connected, but the app could not save the connection. Run the Meta migration in Supabase.",
  failed: "The Meta connection could not be completed. Please try again.",
};

export default function WhatsAppConnection() {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [verifyToken, setVerifyToken] = useState("");
  const [displayPhoneNumber, setDisplayPhoneNumber] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const response = await fetch("/api/meta/connection");
    if (!response.ok) return;
    const body = await response.json();
    setConnection(body.connection);
    if (body.connection) {
      setPhoneNumberId(body.connection.phone_number_id);
      setDisplayPhoneNumber(body.connection.display_phone_number ?? "");
    }
  }

  useEffect(() => {
    void refresh();
    const result = new URLSearchParams(window.location.search).get("meta");
    if (result) setMessage(oauthMessages[result] ?? "Meta connection update received.");
  }, []);

  async function testConnection() {
    setBusy(true); setMessage("");
    const response = await fetch("/api/meta/connection?test=1");
    const body = await response.json();
    setBusy(false);
    setMessage(response.ok ? `Meta connection verified${body.displayPhoneNumber ? ` for ${body.displayPhoneNumber}` : ""}.` : (body.error ?? "Meta connection test failed."));
    await refresh();
  }

  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    const response = await fetch("/api/meta/connection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phoneNumberId, accessToken, verifyToken, displayPhoneNumber }) });
    const body = await response.json(); setBusy(false);
    if (!response.ok) { setMessage(body.error ?? "Unable to save Meta connection."); return; }
    setAccessToken(""); setVerifyToken(""); setMessage("Saved. Complete webhook verification in Meta using the instructions below."); await refresh();
  }

  const webhook = typeof window === "undefined" ? "/api/webhook" : `${window.location.origin}/api/webhook`;
  return <main className="shell"><section className="connection-card"><div className="brand">Hospital WhatsApp</div><h1>Connect Meta WhatsApp Business</h1><p>Use the official WhatsApp Cloud API. Credentials are encrypted before storage.</p>
    {connection && <div className={`connection-status ${connection.status}`}><b>{connection.status === "connected" ? "Connected" : "Disconnected"}</b><span>{connection.display_phone_number || connection.phone_number_id}</span></div>}
    <section className="qr"><h2>Recommended: connect with Meta</h2><p>Sign in to Meta, choose the WhatsApp Business account, and let CareFlow securely save its WhatsApp phone connection.</p><button className="primary" type="button" onClick={() => { window.location.href = "/api/meta/oauth/start"; }}>Connect with Meta</button></section>
    <form onSubmit={save}><h2>Manual connection (fallback)</h2><label className="field">WhatsApp Phone Number ID<input required inputMode="numeric" value={phoneNumberId} onChange={(event) => setPhoneNumberId(event.target.value)} placeholder="From Meta WhatsApp API setup" /></label><label className="field">Permanent access token<input required type="password" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} placeholder={connection ? "Enter a new token to update" : "Meta permanent access token"} /></label><label className="field">Webhook verify token<input required type="password" value={verifyToken} onChange={(event) => setVerifyToken(event.target.value)} placeholder="Create your own secret token" /></label><label className="field">Display phone number (optional)<input value={displayPhoneNumber} onChange={(event) => setDisplayPhoneNumber(event.target.value)} placeholder="For example +91 94208 57650" /></label>{message && <p className="error">{message}</p>}<div style={{ display: "flex", gap: 10 }}><button className="primary" disabled={busy}>{busy ? "Working…" : "Save Meta connection"}</button>{connection && <button type="button" className="secondary" disabled={busy} onClick={testConnection}>Test Meta connection</button>}</div></form>
    <section className="qr"><h2>Meta webhook setup</h2><ol><li>In <b>Meta for Developers</b>, create or select a Business app and add the <b>WhatsApp</b> product.</li><li>Open WhatsApp → Configuration and paste this Callback URL:</li></ol><code className="webhook-url">{webhook}</code><ol start={3}><li>Set the Verify token to the same value as <code>META_WEBHOOK_VERIFY_TOKEN</code> in Vercel.</li><li>Click <b>Verify and save</b>, then subscribe to the <b>messages</b> webhook field.</li></ol></section><a className="back-link" href="/dashboard">← Back to hospital dashboard</a></section></main>;
}

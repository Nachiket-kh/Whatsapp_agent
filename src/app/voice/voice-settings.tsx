"use client";

import { FormEvent, useState } from "react";

type Connection = { agent_id: string; phone_number: string | null; enabled: boolean; updated_at: string } | null;
type Call = { id: string; caller_phone: string | null; status: string; ended_at: string | null; created_at: string };

export default function VoiceSettings({ initialConnection, initialCalls }: { initialConnection: Connection; initialCalls: Call[] }) {
  const [connection, setConnection] = useState(initialConnection);
  const [apiKey, setApiKey] = useState("");
  const [agentId, setAgentId] = useState(initialConnection?.agent_id ?? "");
  const [phoneNumber, setPhoneNumber] = useState(initialConnection?.phone_number ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [urls, setUrls] = useState<{ toolUrl: string; postCallUrl: string } | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const response = await fetch("/api/voice/connection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey, agentId, phoneNumber, enabled: true }) });
    const body = await response.json() as { error?: string; toolUrl?: string; postCallUrl?: string };
    setBusy(false);
    if (!response.ok || !body.toolUrl || !body.postCallUrl) { setError(body.error ?? "Could not save voice-agent settings."); return; }
    setApiKey(""); setConnection({ agent_id: agentId, phone_number: phoneNumber || null, enabled: true, updated_at: new Date().toISOString() }); setUrls({ toolUrl: body.toolUrl, postCallUrl: body.postCallUrl });
  }
  const toolExample = `System prompt:\nYou are the hospital appointment receptionist. Speak in the caller's chosen language: English, Hindi, or Marathi. Before confirming any appointment, call list_doctors, available_slots, then book_appointment. Never invent doctors, dates, or availability.\n\nWebhook tool endpoint: ${urls?.toolUrl ?? "Save the connection to reveal the private endpoint."}`;
  return <main className="shell"><section className="connection-card" style={{ width: "min(100%, 820px)" }}><div className="brand">HOSPITAL VOICE AGENT</div><h1>ElevenLabs call booking</h1><p>Patients can call your ElevenLabs number and book only real, currently available hospital appointments.</p><div className={`connection-status ${connection?.enabled ? "connected" : "disconnected"}`}><b>{connection?.enabled ? "Voice agent configured" : "Not configured"}</b><span>{connection?.phone_number || "No phone number saved"}</span></div><form onSubmit={save}><label className="field">ElevenLabs API key<input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={connection ? "Enter a new key only to replace it" : "Paste your ElevenLabs API key"} required={!connection} /></label><label className="field">ElevenLabs Agent ID<input value={agentId} onChange={(e) => setAgentId(e.target.value)} placeholder="agent_..." required /></label><label className="field">Voice phone number (optional)<input value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} placeholder="Hospital calling number" /></label>{error && <p className="error">{error}</p>}<button className="primary" disabled={busy}>{busy ? "Saving…" : connection ? "Update voice agent" : "Connect ElevenLabs"}</button></form>{urls && <section className="panel" style={{ marginTop: 24 }}><h2>Configure this in ElevenLabs</h2><p>Create three <b>Webhook tools</b> that POST to the private tool URL below. Send the required field <code>action</code> as <code>list_doctors</code>, <code>available_slots</code>, or <code>book_appointment</code>.</p><code className="webhook-url">{urls.toolUrl}</code><p>For post-call transcripts, add this as the ElevenLabs post-call webhook:</p><code className="webhook-url">{urls.postCallUrl}</code><label className="field">Agent system prompt<textarea readOnly value={toolExample} rows={7} /></label></section>}<section className="panel" style={{ marginTop: 24 }}><h2>Recent calls</h2>{initialCalls.length ? <div className="table-wrap"><table><thead><tr><th>Caller</th><th>Status</th><th>Finished</th></tr></thead><tbody>{initialCalls.map((call) => <tr key={call.id}><td>{call.caller_phone || "Unknown"}</td><td>{call.status}</td><td>{new Date(call.ended_at ?? call.created_at).toLocaleString()}</td></tr>)}</tbody></table></div> : <p>No completed calls have been received yet.</p>}</section><a className="back-link" href="/dashboard">← Back to hospital dashboard</a></section></main>;
}

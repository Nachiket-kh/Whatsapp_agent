"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("oscreter@gmail.com");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true); setError("");
    const response = await fetch("/api/session/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
    const body = await response.json() as { error?: string };
    if (!response.ok) { setError(body.error ?? "Unable to sign in."); setLoading(false); return; }
    router.replace("/dashboard"); router.refresh();
  }

  return <main className="shell"><form className="auth-card" onSubmit={signIn}>
    <div className="brand">CreaterOS</div><h1>Hospital dashboard</h1><p>Sign in to manage appointments and patient conversations.</p>
    <label className="field">Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
    <label className="field">Password<input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
    {error && <p className="error">{error}</p>}<button className="primary" disabled={loading}>{loading ? "Signing in…" : "Sign in"}</button>
  </form></main>;
}

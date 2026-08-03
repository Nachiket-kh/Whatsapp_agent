"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true); setError("");
    const { error } = await createClient().auth.signInWithPassword({ email, password });
    if (error) { setError(error.message); setLoading(false); return; }
    router.replace("/dashboard"); router.refresh();
  }

  return <main className="shell"><form className="auth-card" onSubmit={signIn}>
    <div className="brand">QuickShip AI</div><h1>Business dashboard</h1><p>Sign in to monitor customer conversations.</p>
    <label className="field">Email<input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
    <label className="field">Password<input type="password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
    {error && <p className="error">{error}</p>}<button className="primary" disabled={loading}>{loading ? "Signing in…" : "Sign in"}</button>
  </form></main>;
}

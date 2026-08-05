"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";
import styles from "../creatoros.module.css";

export default function EnquirePage() {
  const [search, setSearch] = useState("");
  useEffect(() => setSearch(window.location.search), []);
  const searchParams = new URLSearchParams(search);
  const plan = searchParams.get("plan");
  const consultation = searchParams.get("type") === "consultation";
  const title = consultation ? "Talk with CreatorOS" : `${plan ?? "CreatorOS"} plan enquiry`;

  const defaultMessage = useMemo(() => consultation ? "I would like to talk about a CreatorOS AI agent." : `I would like the ${plan ?? "CreatorOS"} plan.`, [consultation, plan]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const message = [
      defaultMessage,
      `Name: ${data.get("name")}`,
      `Email: ${data.get("email")}`,
      `Mobile: ${data.get("mobile")}`,
      `Hospital address: ${data.get("address")}`,
      `Message: ${data.get("message") || "Not provided"}`,
    ].join("\n");
    window.location.href = `https://wa.me/919420857650?text=${encodeURIComponent(message)}`;
  }

  return <main className={styles.site}><nav className={styles.nav}><Link href="/" className={styles.logo}>Creator<span>OS</span></Link><Link className={styles.login} href="/">Back to website</Link></nav><section className={styles.formPage}><div><p className={styles.kicker}>{consultation ? "FREE CONSULTATION" : "START YOUR PLAN"}</p><h1>{title}</h1><p className={styles.lead}>Fill in your details. Submitting opens WhatsApp with your enquiry ready to send to CreatorOS.</p></div><form className={styles.enquiryForm} onSubmit={submit}><label>Full name<input name="name" required placeholder="Your name" /></label><label>Email address<input name="email" required type="email" placeholder="you@example.com" /></label><label>Mobile number<input name="mobile" required inputMode="tel" pattern="[0-9+ -]{8,}" placeholder="Your mobile number" /></label><label>Hospital address<textarea name="address" required placeholder="Hospital name, city and full address" rows={3} /></label><label>Anything you would like us to know?<textarea name="message" placeholder="Doctors, departments, timings or requirements" rows={3} /></label><button type="submit">Send enquiry on WhatsApp</button></form></section></main>;
}

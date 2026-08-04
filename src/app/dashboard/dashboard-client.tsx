"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Appointment, Conversation, Doctor, HospitalSettings, Message, Patient } from "@/lib/database.types";
import styles from "./mobile.module.css";

type View = "Dashboard" | "Appointments" | "Doctors" | "Patients" | "WhatsApp Chats" | "Calendar" | "Hospital Settings" | "WhatsApp Connection";
const navigation: View[] = ["Dashboard", "Appointments", "Doctors", "Patients", "WhatsApp Chats", "Calendar", "WhatsApp Connection", "Hospital Settings"];
const time = (value: string) => { const [hour, minute] = value.slice(0, 5).split(":").map(Number); return `${((hour + 11) % 12) + 1}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`; };

export default function DashboardClient({ hospitalId, initialConversations, initialMessages, initialAppointments, initialDoctors, initialPatients, initialSettings }: { hospitalId: string; initialConversations: Conversation[]; initialMessages: Message[]; initialAppointments: Appointment[]; initialDoctors: Doctor[]; initialPatients: Patient[]; initialSettings: HospitalSettings | null }) {
  const router = useRouter();
  const [view, setView] = useState<View>("Dashboard");
  const [conversations, setConversations] = useState(initialConversations);
  const [messages, setMessages] = useState(initialMessages);
  const [appointments, setAppointments] = useState(initialAppointments);
  const [doctors, setDoctors] = useState(initialDoctors);
  const [patients, setPatients] = useState(initialPatients);
  const [settings, setSettings] = useState(initialSettings);
  const [dark, setDark] = useState(true);
  const [selected, setSelected] = useState(initialConversations[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const selectedConversation = conversations.find((conversation) => conversation.id === selected);
  const thread = useMemo(() => messages.filter((message) => message.conversation_id === selected), [messages, selected]);
  const today = new Date().toISOString().slice(0, 10);
  const active = appointments.filter((appointment) => appointment.status === "upcoming");

  useEffect(() => {
    setAppointments(initialAppointments); setPatients(initialPatients); setConversations(initialConversations); setMessages(initialMessages); setDoctors(initialDoctors); setSettings(initialSettings);
    if (!selected && initialConversations[0]) setSelected(initialConversations[0].id);
  }, [initialAppointments, initialPatients, initialConversations, initialMessages, initialDoctors, initialSettings, selected]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel(`hospital-dashboard-${hospitalId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "appointments", filter: `hospital_id=eq.${hospitalId}` }, () => router.refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations", filter: `hospital_id=eq.${hospitalId}` }, () => router.refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () => router.refresh())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [hospitalId, router]);

  async function signOut() { await createClient().auth.signOut(); router.replace("/login"); router.refresh(); }
  async function appointmentAction(id: string, status?: "upcoming" | "completed" | "cancelled", remove = false, conversationId?: string | null) {
    const supabase = createClient();
    const { error } = remove ? await supabase.from("appointments").delete().eq("id", id) : await supabase.from("appointments").update({ status }).eq("id", id);
    if (error) { alert(`Unable to update appointment: ${error.message}`); return; }
    if (status === "completed" && conversationId) {
      const [{ error: draftError }, { error: messagesError }] = await Promise.all([
        supabase.from("appointment_drafts").delete().eq("conversation_id", conversationId),
        supabase.from("messages").delete().eq("conversation_id", conversationId),
      ]);
      if (draftError || messagesError) alert(`Checkup completed, but chat could not be cleared: ${(draftError ?? messagesError)?.message}`);
      else setMessages((items) => items.filter((item) => item.conversation_id !== conversationId));
    }
    router.refresh();
  }
  async function clearChat() {
    if (!selectedConversation || !confirm(`Clear chat history for ${selectedConversation.phone_number}? Their next WhatsApp message will start a new appointment booking.`)) return;
    const supabase = createClient();
    const [{ error: draftError }, { error: messagesError }] = await Promise.all([
      supabase.from("appointment_drafts").delete().eq("conversation_id", selectedConversation.id),
      supabase.from("messages").delete().eq("conversation_id", selectedConversation.id),
    ]);
    if (draftError || messagesError) { alert(`Unable to clear chat: ${(draftError ?? messagesError)?.message}`); return; }
    setMessages((items) => items.filter((item) => item.conversation_id !== selectedConversation.id));
    router.refresh();
  }
  async function addDoctor() { const name = prompt("Doctor name"); const department = prompt("Department"); if (!name || !department) return; const { error } = await createClient().from("doctors").insert({ hospital_id: hospitalId, name, department }); if (error) alert(error.message); else router.refresh(); }
  async function toggleDoctor(doctor: Doctor) { const { error } = await createClient().from("doctors").update({ enabled: !doctor.enabled }).eq("id", doctor.id); if (error) alert(error.message); else router.refresh(); }
  async function saveSettings() { if (!settings) return; const { error } = await createClient().from("hospital_settings").upsert({ ...settings, hospital_id: hospitalId }); if (error) alert(error.message); else router.refresh(); }

  const appointmentsTable = <div className="table-wrap"><table><thead><tr>{["Patient", "Phone Number", "Doctor", "Department", "Date", "Time", "Checkup status", "Actions"].map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{appointments.length ? appointments.map((appointment) => <tr key={appointment.id}><td>{appointment.patient_name}</td><td>{appointment.phone_number}</td><td>{appointment.doctor_name ?? "—"}</td><td>{appointment.department ?? "—"}</td><td>{appointment.appointment_date}</td><td>{time(appointment.appointment_time)}</td><td><label className={styles.checkup}><input type="checkbox" checked={appointment.status === "completed"} disabled={appointment.status === "cancelled"} onChange={(event) => appointmentAction(appointment.id, event.target.checked ? "completed" : "upcoming", false, appointment.conversation_id)} /><span>{appointment.status === "cancelled" ? "Cancelled" : "Checkup complete"}</span></label></td><td className="actions"><button onClick={() => alert(JSON.stringify(appointment, null, 2))}>View</button><button onClick={() => appointmentAction(appointment.id, "cancelled")}>Cancel</button><button onClick={() => appointmentAction(appointment.id, undefined, true)}>Delete</button></td></tr>) : <tr><td colSpan={8}>No appointments yet. WhatsApp bookings will appear here automatically.</td></tr>}</tbody></table></div>;

  let content: React.ReactNode;
  if (view === "Dashboard") content = <><div className="page-title"><div><div className="eyebrow">{settings?.hospital_name ?? "ABC HOSPITAL"}</div><h1>Hospital Dashboard</h1><p>Appointment activity at a glance.</p></div><button className="primary small" onClick={() => router.refresh()}>Refresh bookings</button></div><div className="stats">{[["Today’s Appointments", active.filter((appointment) => appointment.appointment_date === today).length], ["Upcoming", active.length], ["Completed", appointments.filter((appointment) => appointment.status === "completed").length], ["Cancelled", appointments.filter((appointment) => appointment.status === "cancelled").length], ["Total Patients", patients.length]].map(([label, value]) => <article className="stat" key={String(label)}><span>{label}</span><strong>{value}</strong></article>)}</div><section className="panel"><h2>Appointments</h2>{appointmentsTable}</section></>;
  else if (view === "Appointments") content = <><div className="page-title"><div><div className="eyebrow">SCHEDULING</div><h1>Appointments</h1></div><button className="primary small" onClick={() => router.refresh()}>Refresh</button></div>{appointmentsTable}</>;
  else if (view === "Doctors") content = <><div className="page-title"><div><div className="eyebrow">CLINICAL TEAM</div><h1>Doctors</h1></div><button className="primary small" onClick={addDoctor}>+ Add doctor</button></div><div className="doctor-grid">{doctors.map((doctor) => <article className="doctor-card" key={doctor.id}><span className="avatar">{doctor.name.slice(0, 1)}</span><h2>{doctor.name}</h2><p>{doctor.department}</p><small>{doctor.working_days.join(", ")} · {time(doctor.start_time)}–{time(doctor.end_time)} · {doctor.consultation_duration} min</small><button onClick={() => toggleDoctor(doctor)}>{doctor.enabled ? "Disable" : "Enable"}</button></article>)}</div></>;
  else if (view === "Patients") content = <><div className="page-title"><div><div className="eyebrow">PATIENT DIRECTORY</div><h1>Patients</h1></div></div><div className="table-wrap"><table><thead><tr><th>Name</th><th>Phone Number</th><th>Last Seen</th></tr></thead><tbody>{patients.map((patient) => <tr key={patient.id}><td>{patient.full_name ?? "—"}</td><td>{patient.phone_number}</td><td>{new Date(patient.last_seen).toLocaleString()}</td></tr>)}</tbody></table></div></>;
  else if (view === "WhatsApp Chats") content = <div className="chat-page"><aside className="chat-list"><input placeholder="Search conversations" value={query} onChange={(event) => setQuery(event.target.value)} />{conversations.filter((conversation) => conversation.phone_number.includes(query)).map((conversation) => <button className={conversation.id === selected ? "selected" : ""} onClick={() => setSelected(conversation.id)} key={conversation.id}><b>{patients.find((patient) => patient.phone_number === conversation.phone_number)?.full_name ?? "Patient"}</b><small>{conversation.phone_number}</small></button>)}</aside><section className="whatsapp-thread" style={{ minHeight: 0 }}><>{selectedConversation ? <><header><div><b>{patients.find((patient) => patient.phone_number === selectedConversation.phone_number)?.full_name ?? "Patient"}</b><small>{selectedConversation.phone_number} · Last seen {new Date(selectedConversation.updated_at).toLocaleString()}</small></div><div style={{ display: "flex", gap: 8, alignItems: "center" }}><span className="badge upcoming">WhatsApp</span><button onClick={clearChat} style={{ color: "#ffb2b7", border: "1px solid #754046", padding: "5px 8px" }}>Clear chat</button></div></header><main style={{ minHeight: 0, overflowY: "auto" }}>{thread.length ? thread.map((message) => <div className={`bubble ${message.role}`} key={message.id}>{message.content}</div>) : <div className="empty">Chat is clear. The patient’s next message starts a new booking.</div>}</main></> : <div className="empty">Choose a patient conversation</div>}</></section></div>;
  else if (view === "Calendar") content = <><div className="page-title"><div><div className="eyebrow">CALENDAR</div><h1>Upcoming schedule</h1></div></div><div className="calendar-list">{active.map((appointment) => <article key={appointment.id}><b>{appointment.appointment_date} · {time(appointment.appointment_time)}</b><span>{appointment.patient_name} with {appointment.doctor_name ?? appointment.department}</span></article>)}</div></>;
  else if (view === "WhatsApp Connection") content = <><div className="page-title"><div><div className="eyebrow">WHATSAPP PROVIDER</div><h1>Evolution API connection</h1><p>Connect this hospital&apos;s WhatsApp account and manage QR pairing.</p></div></div><section className="panel"><a className="primary small" href="/whatsapp">Open WhatsApp connection</a></section></>;
  else content = <><div className="page-title"><div><div className="eyebrow">ADMINISTRATION</div><h1>Hospital Settings</h1></div></div>{settings && <section className="panel settings"><label>Hospital name<input value={settings.hospital_name} onChange={(event) => setSettings({ ...settings, hospital_name: event.target.value })} /></label><label>Departments (comma separated)<input value={settings.departments.join(", ")} onChange={(event) => setSettings({ ...settings, departments: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} /></label><label>Opening time<input type="time" value={settings.opening_time.slice(0, 5)} onChange={(event) => setSettings({ ...settings, opening_time: event.target.value })} /></label><label>Closing time<input type="time" value={settings.closing_time.slice(0, 5)} onChange={(event) => setSettings({ ...settings, closing_time: event.target.value })} /></label><label>Slot duration (minutes)<input type="number" value={settings.slot_duration} onChange={(event) => setSettings({ ...settings, slot_duration: Number(event.target.value) })} /></label><button className="primary small" onClick={saveSettings}>Save settings</button></section>}</>;
  return <main className={`hospital ${styles.responsive}`} data-theme={dark ? "dark" : "light"}><aside className="main-nav"><div className="hospital-brand"><span>✚</span><b>{settings?.hospital_name ?? "ABC Hospital"}</b><small>Appointment assistant</small></div>{navigation.map((item) => <button key={item} onClick={() => setView(item)} className={view === item ? "active" : ""}>{item}</button>)}<button onClick={() => setDark((value) => !value)}>{dark ? "☀ Light mode" : "◐ Dark mode"}</button><button className="signout" onClick={signOut}>Sign out</button></aside><section className="content">{content}</section></main>;
}

"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Appointment, Conversation, Doctor, HospitalSettings, Message, Patient } from "@/lib/database.types";
import styles from "./mobile.module.css";

type View = "Dashboard" | "Appointments" | "Doctors" | "Patients" | "WhatsApp Chats" | "Calendar" | "Hospital Settings" | "WhatsApp Connection" | "Voice Agent";
const navigation: View[] = ["Dashboard", "Appointments", "Calendar", "WhatsApp Chats", "Hospital Settings", "Doctors", "Patients", "WhatsApp Connection", "Voice Agent"];
const time = (value: string) => { const [hour, minute] = value.slice(0, 5).split(":").map(Number); return `${((hour + 11) % 12) + 1}:${String(minute).padStart(2, "0")} ${hour >= 12 ? "PM" : "AM"}`; };
const defaultSettings: HospitalSettings = { hospital_name: "ABC Hospital", hospital_logo: null, departments: [], opening_time: "09:00", closing_time: "17:00", slot_duration: 20, emergency_number: null, whatsapp_number: null, chat_retention_hours: 24 };

export default function DashboardClient({ hospitalId, initialConversations, initialMessages, initialAppointments, initialDoctors, initialPatients, initialSettings }: { hospitalId: string; initialConversations: Conversation[]; initialMessages: Message[]; initialAppointments: Appointment[]; initialDoctors: Doctor[]; initialPatients: Patient[]; initialSettings: HospitalSettings | null }) {
  const router = useRouter();
  const [view, setView] = useState<View>("Dashboard");
  const [conversations, setConversations] = useState(initialConversations);
  const [messages, setMessages] = useState(initialMessages);
  const [appointments, setAppointments] = useState(initialAppointments);
  const [doctors, setDoctors] = useState(initialDoctors);
  const [patients, setPatients] = useState(initialPatients);
  const [settings, setSettings] = useState<HospitalSettings>(initialSettings ?? defaultSettings);
  const [viewingAppointment, setViewingAppointment] = useState<Appointment | null>(null);
  const [dark, setDark] = useState(true);
  const [selected, setSelected] = useState(initialConversations[0]?.id ?? "");
  const [query, setQuery] = useState("");
  const selectedConversation = conversations.find((conversation) => conversation.id === selected);
  const thread = useMemo(() => messages.filter((message) => message.conversation_id === selected), [messages, selected]);
  const today = new Date().toISOString().slice(0, 10);
  const active = appointments.filter((appointment) => appointment.status === "upcoming");

  useEffect(() => {
    setAppointments(initialAppointments); setPatients(initialPatients); setConversations(initialConversations); setMessages(initialMessages); setDoctors(initialDoctors); setSettings(initialSettings ?? defaultSettings);
    setSelected((current) => initialConversations.some((conversation) => conversation.id === current) ? current : (initialConversations[0]?.id ?? ""));
  }, [initialAppointments, initialPatients, initialConversations, initialMessages, initialDoctors, initialSettings]);

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase.channel(`hospital-dashboard-${hospitalId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "appointments", filter: `hospital_id=eq.${hospitalId}` }, () => router.refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "conversations", filter: `hospital_id=eq.${hospitalId}` }, () => router.refresh())
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () => router.refresh())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [hospitalId, router]);

  // Realtime can be unavailable if a legacy Supabase project has not added a
  // table to its publication. This keeps WhatsApp bookings visible regardless.
  useEffect(() => {
    const timer = window.setInterval(() => router.refresh(), 30000);
    return () => window.clearInterval(timer);
  }, [router]);

  async function signOut() { await createClient().auth.signOut(); router.replace("/login"); router.refresh(); }
  async function appointmentAction(id: string, status?: "upcoming" | "completed" | "cancelled", remove = false, conversationId?: string | null) {
    const confirmation = remove ? "Delete this appointment permanently?" : status === "cancelled" ? "Cancel this appointment?" : "";
    if (confirmation && !confirm(confirmation)) return;
    const response = await fetch(`/api/appointments/${id}`, remove ? { method: "DELETE" } : { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) });
    const body = await response.json() as { error?: string; appointment?: Appointment };
    if (!response.ok) { alert(`Unable to update appointment: ${body.error ?? "Unknown error"}`); return; }
    if (remove) setAppointments((items) => items.filter((item) => item.id !== id));
    else if (body.appointment) setAppointments((items) => items.map((item) => item.id === id ? body.appointment! : item));
    if (status === "completed" && conversationId) setMessages((items) => items.filter((item) => item.conversation_id !== conversationId));
    router.refresh();
  }
  async function clearChat() {
    if (!selectedConversation || !confirm(`Clear chat history for ${selectedConversation.phone_number}? Their next WhatsApp message will start a new appointment booking.`)) return;
    const response = await fetch(`/api/conversations/${selectedConversation.id}/clear`, { method: "POST" });
    const body = await response.json() as { error?: string };
    if (!response.ok) { alert(body.error ?? "Unable to clear chat."); return; }
    setMessages((items) => items.filter((item) => item.conversation_id !== selectedConversation.id));
    router.refresh();
  }
  async function deleteContact() {
    if (!selectedConversation || !confirm(`Delete ${selectedConversation.phone_number}, their chat, and unfinished booking? Appointment records will be kept.`)) return;
    const response = await fetch(`/api/conversations/${selectedConversation.id}/clear`, { method: "DELETE" });
    const body = await response.json() as { error?: string; patientDeleted?: boolean };
    if (!response.ok) { alert(body.error ?? "Unable to delete contact."); return; }
    const phone = selectedConversation.phone_number;
    setConversations((items) => items.filter((item) => item.id !== selectedConversation.id));
    setMessages((items) => items.filter((item) => item.conversation_id !== selectedConversation.id));
    if (body.patientDeleted) setPatients((items) => items.filter((item) => item.phone_number !== phone));
    setSelected("");
    router.refresh();
  }
  async function addDoctor() { const name = prompt("Doctor name"); const department = prompt("Department"); if (!name || !department) return; const { error } = await createClient().from("doctors").insert({ hospital_id: hospitalId, name, department }); if (error) alert(error.message); else router.refresh(); }
  async function toggleDoctor(doctor: Doctor) { const response = await fetch(`/api/doctors/${doctor.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: !doctor.enabled }) }); const body = await response.json() as { error?: string; doctor?: Doctor }; if (!response.ok || !body.doctor) { alert(body.error ?? "Unable to update doctor availability."); return; } setDoctors((items) => items.map((item) => item.id === doctor.id ? body.doctor! : item)); router.refresh(); }
  async function saveSettings() {
    const response = await fetch("/api/hospital-settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) });
    const body = await response.json() as { error?: string; settings?: HospitalSettings };
    if (!response.ok) { alert(body.error ?? "Unable to save hospital settings."); return; }
    if (body.settings) setSettings(body.settings);
    router.refresh();
  }

  const appointmentsTable = <div className="table-wrap"><table><thead><tr>{["Patient", "Phone Number", "Doctor", "Department", "Date", "Time", "Checkup status", "Actions"].map((label) => <th key={label}>{label}</th>)}</tr></thead><tbody>{appointments.length ? appointments.map((appointment) => <tr key={appointment.id}><td>{appointment.patient_name}</td><td>{appointment.phone_number}</td><td>{appointment.doctor_name ?? "-"}</td><td>{appointment.department ?? "-"}</td><td>{appointment.appointment_date}</td><td>{time(appointment.appointment_time)}</td><td><label className={styles.checkup}><input type="checkbox" checked={appointment.status === "completed"} disabled={appointment.status === "cancelled"} onChange={(event) => appointmentAction(appointment.id, event.target.checked ? "completed" : "upcoming", false, appointment.conversation_id)} /><span>{appointment.status === "cancelled" ? "Cancelled" : appointment.status === "completed" ? "Checkup complete" : "Checkup incomplete"}</span></label></td><td className="actions"><button onClick={() => setViewingAppointment(appointment)}>View</button><button disabled={appointment.status !== "upcoming"} onClick={() => appointmentAction(appointment.id, "cancelled")}>Cancel</button><button onClick={() => appointmentAction(appointment.id, undefined, true)}>Delete</button></td></tr>) : <tr><td colSpan={8}>No appointments yet. WhatsApp bookings will appear here automatically.</td></tr>}</tbody></table></div>;

  let content: React.ReactNode;
  if (view === "Dashboard") content = <><div className="page-title"><div><div className="eyebrow">{settings?.hospital_name ?? "ABC HOSPITAL"}</div><h1>Hospital Dashboard</h1><p>Appointment activity at a glance.</p></div><button className="primary small" onClick={() => router.refresh()}>Refresh bookings</button></div><div className="stats">{[["Today’s Appointments", active.filter((appointment) => appointment.appointment_date === today).length], ["Upcoming", active.length], ["Completed", appointments.filter((appointment) => appointment.status === "completed").length], ["Cancelled", appointments.filter((appointment) => appointment.status === "cancelled").length], ["Total Patients", patients.length]].map(([label, value]) => <article className="stat" key={String(label)}><span>{label}</span><strong>{value}</strong></article>)}</div><section className="panel"><h2>Appointments</h2>{appointmentsTable}</section></>;
  else if (view === "Appointments") content = <><div className="page-title"><div><div className="eyebrow">SCHEDULING</div><h1>Appointments</h1></div><button className="primary small" onClick={() => router.refresh()}>Refresh</button></div>{appointmentsTable}</>;
  else if (view === "Doctors") content = <><div className="page-title"><div><div className="eyebrow">CLINICAL TEAM</div><h1>Doctors</h1><p>Only doctors marked available are offered by WhatsApp and n8n.</p></div><button className="primary small" onClick={addDoctor}>+ Add doctor</button></div><div className="doctor-grid">{doctors.map((doctor) => <article className="doctor-card" key={doctor.id}><span className="avatar">{doctor.name.slice(0, 1)}</span><h2>{doctor.name}</h2><p>{doctor.department}</p><small>{doctor.working_days.join(", ")} · {time(doctor.start_time)}–{time(doctor.end_time)} · {doctor.consultation_duration} min</small><label className={styles.availability}><input type="checkbox" checked={doctor.enabled} onChange={() => toggleDoctor(doctor)} /><span className={doctor.enabled ? styles.available : styles.unavailable}>{doctor.enabled ? "Available for booking" : "Unavailable"}</span></label></article>)}</div></>;
  else if (view === "Patients") content = <><div className="page-title"><div><div className="eyebrow">PATIENT DIRECTORY</div><h1>Patients</h1></div></div><div className="table-wrap"><table><thead><tr><th>Name</th><th>Phone Number</th><th>Last Seen</th></tr></thead><tbody>{patients.map((patient) => <tr key={patient.id}><td>{patient.full_name ?? "—"}</td><td>{patient.phone_number}</td><td>{new Date(patient.last_seen).toLocaleString()}</td></tr>)}</tbody></table></div></>;
  else if (view === "WhatsApp Chats") content = <div className="chat-page"><aside className="chat-list"><input placeholder="Search conversations" value={query} onChange={(event) => setQuery(event.target.value)} />{conversations.filter((conversation) => conversation.phone_number.includes(query)).map((conversation) => <button className={conversation.id === selected ? "selected" : ""} onClick={() => setSelected(conversation.id)} key={conversation.id}><b>{patients.find((patient) => patient.phone_number === conversation.phone_number)?.full_name ?? "Patient"}</b><small>{conversation.phone_number}</small></button>)}</aside><section className="whatsapp-thread" style={{ minHeight: 0 }}><>{selectedConversation ? <><header><div><b>{patients.find((patient) => patient.phone_number === selectedConversation.phone_number)?.full_name ?? "Patient"}</b><small>{selectedConversation.phone_number} · Last seen {new Date(selectedConversation.updated_at).toLocaleString()}</small></div><div className={styles.chatActions}><span className="badge upcoming">WhatsApp</span><button onClick={clearChat}>Clear chat</button><button className={styles.deleteContact} onClick={deleteContact}>Delete contact</button></div></header><main style={{ minHeight: 0, overflowY: "auto" }}>{thread.length ? thread.map((message) => <div className={`bubble ${message.role}`} key={message.id}>{message.content}</div>) : <div className="empty">Chat is clear. The patient’s next message starts a new booking.</div>}</main></> : <div className="empty">Choose a patient conversation</div>}</></section></div>;
  else if (view === "Calendar") content = <><div className="page-title"><div><div className="eyebrow">CALENDAR</div><h1>Upcoming schedule</h1></div><button className="primary small" onClick={() => router.refresh()}>Refresh</button></div><div className="calendar-list">{active.length ? active.map((appointment) => <article key={appointment.id}><b>{appointment.appointment_date} · {time(appointment.appointment_time)}</b><span>{appointment.patient_name} with {appointment.doctor_name ?? appointment.department}</span></article>) : <article><b>No upcoming appointments</b><span>New WhatsApp bookings will appear here automatically.</span></article>}</div></>;
  else if (view === "WhatsApp Connection") content = <><div className="page-title"><div><div className="eyebrow">WHATSAPP PROVIDER</div><h1>Meta WhatsApp Cloud API</h1><p>Connect Meta directly to CareFlow. The app securely receives messages, manages hospital information, checks live slots, and creates appointments.</p></div></div><section className="panel"><a className="primary small" href="/whatsapp">Open Meta WhatsApp connection</a></section></>;
  else if (view === "Voice Agent") content = <><div className="page-title"><div><div className="eyebrow">PHONE APPOINTMENTS</div><h1>AI Voice Receptionist</h1><p>Connect Vapi so patients can call, check live availability, and book appointments securely.</p></div></div><section className="panel"><a className="primary small" href="/voice">Open AI Voice Receptionist</a><a className="primary small" href="/ai" style={{ marginLeft: 10 }}>Configure Chat AI</a></section></>;
  else content = <><div className="page-title"><div><div className="eyebrow">ADMINISTRATION</div><h1>Hospital Settings</h1></div></div><section className="panel settings"><label>Hospital name<input value={settings.hospital_name} onChange={(event) => setSettings({ ...settings, hospital_name: event.target.value })} /></label><label>Departments (comma separated)<input value={settings.departments.join(", ")} onChange={(event) => setSettings({ ...settings, departments: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} /></label><label>Opening time<input type="time" value={settings.opening_time.slice(0, 5)} onChange={(event) => setSettings({ ...settings, opening_time: event.target.value })} /></label><label>Closing time<input type="time" value={settings.closing_time.slice(0, 5)} onChange={(event) => setSettings({ ...settings, closing_time: event.target.value })} /></label><label>Slot duration (minutes)<input type="number" value={settings.slot_duration} onChange={(event) => setSettings({ ...settings, slot_duration: Number(event.target.value) })} /></label><label>Chat and contact retention (hours)<input type="number" min="1" max="720" value={settings.chat_retention_hours ?? 24} onChange={(event) => setSettings({ ...settings, chat_retention_hours: Math.min(720, Math.max(1, Number(event.target.value) || 24)) })} /><small>Default: 24 hours. Chats are cleared automatically; patient records with appointments are retained for the dashboard.</small></label><button className="primary small" onClick={saveSettings}>Save settings</button></section></>;
  return <main className={`hospital ${styles.responsive}`} data-theme={dark ? "dark" : "light"}><aside className="main-nav"><div className="hospital-brand"><span>+</span><b>{settings?.hospital_name ?? "ABC Hospital"}</b><small>Appointment assistant</small></div>{navigation.map((item) => <button key={item} onClick={() => setView(item)} className={view === item ? "active" : ""}>{item}</button>)}<button onClick={() => setDark((value) => !value)}>{dark ? "Light mode" : "Dark mode"}</button><button className="signout" onClick={signOut}>Sign out</button></aside><section className="content">{content}</section>{viewingAppointment && <div className={styles.modalBackdrop} role="dialog" aria-modal="true"><section className={styles.modal}><button className={styles.close} onClick={() => setViewingAppointment(null)} aria-label="Close patient details">x</button><div className={styles.modalEyebrow}>PATIENT APPOINTMENT</div><h2>{viewingAppointment.patient_name}</h2><p className={styles.modalStatus}>{viewingAppointment.status === "completed" ? "Checkup complete" : viewingAppointment.status === "cancelled" ? "Cancelled" : "Checkup incomplete"}</p><dl><div><dt>Phone</dt><dd>{viewingAppointment.phone_number}</dd></div><div><dt>Doctor</dt><dd>{viewingAppointment.doctor_name ?? "Not assigned"}</dd></div><div><dt>Department</dt><dd>{viewingAppointment.department ?? "Not assigned"}</dd></div><div><dt>Date</dt><dd>{viewingAppointment.appointment_date}</dd></div><div><dt>Time</dt><dd>{time(viewingAppointment.appointment_time)}</dd></div><div><dt>Reason for visit</dt><dd>{viewingAppointment.reason ?? "Not provided"}</dd></div><div><dt>Booked</dt><dd>{new Date(viewingAppointment.created_at).toLocaleString()}</dd></div></dl><button className="primary small" onClick={() => setViewingAppointment(null)}>Close</button></section></div>}</main>;
}

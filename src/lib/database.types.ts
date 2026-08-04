export type Conversation = {
  id: string;
  phone_number: string;
  created_at: string;
  updated_at: string;
};

export type Message = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

export type Doctor = { id: string; name: string; department: string; enabled: boolean; working_days: string[]; start_time: string; end_time: string; consultation_duration: number };
export type Appointment = { id: string; conversation_id: string | null; patient_name: string; phone_number: string; doctor_name: string | null; department: string | null; appointment_date: string; appointment_time: string; status: "upcoming" | "completed" | "cancelled"; created_at: string };
export type Patient = { id: string; phone_number: string; full_name: string | null; last_seen: string };
export type HospitalSettings = { hospital_name: string; hospital_logo: string | null; departments: string[]; opening_time: string; closing_time: string; slot_duration: number; emergency_number: string | null; whatsapp_number: string | null };

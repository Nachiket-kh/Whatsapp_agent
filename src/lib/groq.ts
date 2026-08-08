type Language = "English" | "Hindi" | "Marathi";

type HospitalContext = {
  hospitalName: string;
  openingTime: string;
  closingTime: string;
  departments: string[];
  doctors: string[];
};

export async function askGroqReceptionist(input: { language: Language; patientMessage: string; context: HospitalContext }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  const context = input.context;
  const languageRule = input.language === "Hindi" ? "Reply in Hindi (Devanagari script)." : input.language === "Marathi" ? "Reply in Marathi (Devanagari script)." : "Reply in English.";
  const system = `You are a helpful hospital reception assistant in India. ${languageRule}
Use only the hospital facts supplied below. Be warm, concise, and practical.
You may answer general questions about listed doctors, departments and timings. Do not diagnose, prescribe, estimate fees, promise availability, or claim to access medical records. For an emergency, tell the patient to call local emergency services or go to the nearest emergency department. If asked for medical advice, say hospital staff or a doctor must confirm it. Do not book, cancel, or reschedule appointments: the booking workflow will do that safely.
Hospital facts: ${JSON.stringify(context)}`;
  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llama-3.3-70b-versatile", temperature: 0.2, max_tokens: 220, messages: [{ role: "system", content: system }, { role: "user", content: input.patientMessage }] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) { console.error("Groq receptionist request failed", { status: response.status }); return null; }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const reply = payload.choices?.[0]?.message?.content?.trim();
    return reply ? reply.slice(0, 1400) : null;
  } catch (error) {
    console.error("Groq receptionist request failed", error instanceof Error ? error.message : error);
    return null;
  }
}

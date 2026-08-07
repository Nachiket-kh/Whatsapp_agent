# CareFlow n8n WhatsApp booking flow

## Evolution API workflow (recommended)

Use `careflow-evolution-dashboard-booking.json` when WhatsApp is connected through Evolution API. It saves incoming and outgoing messages to the dashboard, uses only doctors marked **Available for booking**, reads live slots, and creates the dashboard appointment only after the patient confirms. It does not need Meta credentials inside n8n: Evolution sends events to the n8n Webhook, and CareFlow uses the encrypted Evolution credentials saved at `/evolution` to send replies.

1. Run `supabase/evolution-migration.sql` in Supabase SQL Editor.
2. In CareFlow, open `/evolution` and save the Evolution server URL, API key, and instance name. The status must be **Connected** after you scan the QR in Evolution.
3. Import `careflow-evolution-dashboard-booking.json` into n8n Cloud.
4. Create/select the Gemini credential and CareFlow Header Auth credential (`x-n8n-secret`).
5. Activate the workflow and copy its **Production URL** from `Evolution Incoming WhatsApp`.
6. In Evolution Manager → instance → Webhook, paste that Production URL, enable the webhook, enable `MESSAGES_UPSERT`, and save.

The Evolution workflow calls CareFlow to read doctors and open slots, and CareFlow calls Evolution to send the AI reply. Appointments created through it appear in the normal dashboard.

Import `appointment-booking-workflow.json` in n8n Cloud. It uses a fixed CareFlow API URL and n8n Cloud credentials; it does not require n8n environment variables.

## Required Vercel variable

```text
N8N_API_SECRET=create-a-long-random-secret
```

## Configure in n8n

1. Create a Meta WhatsApp Cloud API credential using the permanent access token and WhatsApp Phone Number ID.
2. Create a Google Gemini credential using the Gemini API key.
3. Create an n8n Cloud credential: **Credentials → Add credential → Header Auth**. Name it `CareFlow API Secret`, set header name to `x-n8n-secret`, and set its value to the exact same value as `N8N_API_SECRET` in Vercel.
4. Import the workflow and select the Meta, Gemini, and `CareFlow API Secret` credentials in their matching nodes.
5. Ensure the Google Gemini model is available in your n8n version; change it if n8n offers another Gemini Flash model.
6. Activate the workflow. n8n displays a production webhook URL for the WhatsApp Trigger.
7. In Meta WhatsApp Configuration, replace the Callback URL with the n8n production webhook URL and subscribe to `messages`.

## CareFlow API endpoints

The Header Auth credential automatically supplies the required `x-n8n-secret` header.

- `GET /api/n8n/appointment-context?phoneNumberId=...` returns doctors, departments, and hospital hours.
- `POST /api/n8n/available-slots` receives `phoneNumberId`, `doctorId`, and `date`.
- `POST /api/n8n/book-appointment` receives patient, doctor, confirmed date, and confirmed time. It validates the slot again and creates the dashboard appointment.

Do not expose `N8N_API_SECRET`, Meta tokens, or Gemini API keys in WhatsApp messages or browser code.

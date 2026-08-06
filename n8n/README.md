# CareFlow n8n WhatsApp booking flow

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

# CareFlow n8n WhatsApp booking flow

Import `appointment-booking-workflow.json` in n8n. It is a template: n8n credentials and environment variables are deliberately not included.

## Required n8n variables

```text
CAREFLOW_URL=https://your-careflow-domain.com
CAREFLOW_N8N_SECRET=the-same-long-random-value-as-N8N_API_SECRET-in-Vercel
```

## Configure in n8n

1. Create a Meta WhatsApp Cloud API credential using the permanent access token and WhatsApp Phone Number ID.
2. Create a Google Gemini credential using the Gemini API key.
3. Import the workflow and select those credentials in the WhatsApp Trigger, Send WhatsApp Reply, and Google Gemini nodes.
4. Ensure the Google Gemini model is available in your n8n version; change it if n8n offers another Gemini Flash model.
5. Activate the workflow. n8n displays a production webhook URL for the WhatsApp Trigger.
6. In Meta WhatsApp Configuration, replace the Callback URL with the n8n production webhook URL and subscribe to `messages`.

## CareFlow API endpoints

All requests must provide the `x-n8n-secret` header.

- `GET /api/n8n/appointment-context?phoneNumberId=...` returns doctors, departments, and hospital hours.
- `POST /api/n8n/available-slots` receives `phoneNumberId`, `doctorId`, and `date`.
- `POST /api/n8n/book-appointment` receives patient, doctor, confirmed date, and confirmed time. It validates the slot again and creates the dashboard appointment.

Do not expose `N8N_API_SECRET`, Meta tokens, or Gemini API keys in WhatsApp messages or browser code.

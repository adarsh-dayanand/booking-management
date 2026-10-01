# Booking Management Bot (POC)

A simple, multi-tenant appointment-booking backend for clinics: Postgres as the
source of truth, real Google Calendar sync, and one shared conversational
booking flow reused by both an **embeddable web chat widget** (for a clinic's
own website) and a **WhatsApp bot**. Built as a lean single Express app — no
monorepo, no job-queue worker, no build step for the frontend.

See [`docs/brd.md`](docs/brd.md) for the full business requirements this is
scoped down from.

## What's simplified here (read before demoing)

- **No migration framework.** `db/schema.sql` is applied once by hand. Before
  any real production use, replace this with versioned migrations.
- **Background work is an in-process timer**, not a job queue. Fine for one instance; use a real
  queue/advisory locks before running several. Conversation locking is also in-process.
- **No fine-grained roles.** Any row in `staff_users` can do anything for its
  tenant; no password reset. Rate limiting is a simple in-memory limiter.
- **No onboarding API for services/practitioners/hours** — set them up in SQL (see `db/seed.sql`).
- **Row-level security is not enabled.** Every query is manually scoped by
  `tenant_id` in application code, which is correct but has no DB-level
  backstop yet.
- A standalone hosted booking page is not built — only the embeddable chat
  widget and WhatsApp exist as entry points for patients.

## Prerequisites

- Node.js 20+ (tested on Node 24)
- A local Postgres server you can create databases on (not installed by this
  project — see below)

## 1. Install dependencies

```bash
npm install
```

## 2. Set up Postgres

Install Postgres however you prefer, e.g. via Homebrew on macOS:

```bash
brew install postgresql@16
brew services start postgresql@16
```

Then create the two databases this project uses:

```bash
createdb booking_management_bot
createdb booking_management_bot_test
```

## 3. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env`:
- `DATABASE_URL` / `DATABASE_URL_TEST` — point these at the databases you just created.
- `JWT_SECRET` — any long random string.
- `CRYPTO_KEY` — generate with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```
- `GOOGLE_*` and `WHATSAPP_*` — leave blank for now; see the sections below. The
  app runs fine without them, it just won't sync to a real calendar or send
  real WhatsApp messages until you fill them in.

## 4. Apply the schema and seed demo data

```bash
npm run db:setup
npm run db:seed
npm run db:setup:test   # only needed to run the integration test
```

This creates a demo tenant (`demo-clinic`), one service, one practitioner
resource with Mon–Fri 09:00–17:00 hours, and a staff login:
- email: `owner@demo-clinic.test`
- password: `password123`

## 5. Run it

```bash
npm run dev
```

- Staff dashboard: http://localhost:4000/admin.html
- Health check: http://localhost:4000/health

To try the patient-facing chat widget, create a throwaway local HTML file
(standing in for "the clinic's own website") anywhere on disk:

```html
<!doctype html>
<html><body>
  <h1>Demo Clinic Website</h1>
  <script src="http://localhost:4000/widget.js" data-tenant="demo-clinic" defer></script>
</body></html>
```

Open it in a browser, click the chat bubble in the bottom-right corner, and
book an appointment. It'll show up in the staff dashboard for approval
(the demo tenant uses `staff_approval` policy).

## 6. Run tests

```bash
npm test
```

This runs the pure unit tests (slot generation, state machine — no DB needed)
plus the concurrency integration test (needs `DATABASE_URL_TEST` set up per
step 4 above) that proves two simultaneous bookings for the same time slot
can't both succeed.

## Swagger UI: try the agent and watch what it does

`npm run dev`, then open **http://localhost:4000/docs** (raw spec: `/openapi.json`).

- **`POST /v1/public/{tenantSlug}/chat/messages`** — talk to the agent (`tenantSlug = demo-clinic`; reuse a `sessionId`
  to continue, `DELETE …/chat/sessions/{sessionId}` to reset).
  - `?stream=false` (default): one JSON reply. `?stream=true`: Server-Sent Events (`text_delta` as the model writes, then `done`).
  - `?trace=true`: also returns what the agent did — each `tool_call` (name + arguments), its `tool_result`, and the model's text per step.
    In a stream these arrive as `tool_call` / `tool_result` / `model_text` events. Swagger UI buffers SSE, so it shows the full
    ordered log when the turn ends; use `curl -N` to watch live.
- **`GET …/agent/info`** — the exact system prompt and tool definitions for the clinic.
- Try both flows: `POST /v1/admin/login` → **Authorize** → `PUT /v1/admin/settings` (`instant` vs `staff_approval`) → book via chat → approve under *admin*.

Docs and trace are on by default outside production; in production set `ENABLE_DOCS=1` / `AGENT_TRACE=1` to expose them.

## Patients: identified by phone number, no registration

The phone number is the identity (one patient per number per clinic; `9876543210`, `+91 98765 43210` and `09876543210`
are the same person). There is no sign-up step — the first message creates the patient and the agent processes the
query in the same turn:

- **WhatsApp:** the sender's number (signed by Meta) is both the identity and the proof. The patient is created with the
  WhatsApp profile name (replaced once they state their real name); as they mention name, email, date of birth or
  preferred language the agent saves it with `save_patient_details`. Returning patients are recognised and not re-asked.
- **Web chat:** the number is only a claim until proven. The visitor gets a 6-digit code over WhatsApp (valid 10 minutes,
  5 attempts, 3 codes/hour per number) via the agent (`send_phone_otp` / `verify_phone_otp`) or
  `POST …/chat/sessions/{sessionId}/phone/otp` and `…/phone/verify`. Until verified, the agent can't book or manage
  appointments and is told not to reveal anything stored for that number. A host page can pass `phone`/`name` in the chat
  request to capture the contact immediately (unverified).
- With WhatsApp not configured (local dev) the code is returned as `devCode` so the flow can be tried in Swagger. This
  only happens when `AGENT_TRACE` is on (the default outside production) — keep it off in production.
- Each booking keeps the name it was made under (`appointments.patient_name`), so booking for a family member on a shared
  phone doesn't rename the profile. Staff can look patients up with `GET /v1/admin/patients?phone=…` and
  `GET /v1/admin/patients/{id}`.

## The agent and the two booking flows

With `GEMINI_API_KEY` set, a Gemini agent ([`src/chat/agent.ts`](src/chat/agent.ts)) talks to patients on WhatsApp and the
web widget: it books, lists, reschedules and cancels appointments and answers questions from the clinic's FAQ
text. It can only act through the tools in [`src/chat/agentTools.ts`](src/chat/agentTools.ts), which call `booking.ts` —
the only code that changes appointments. The tools re-check every slot against clinic hours, existing
bookings and the doctor's live Google free/busy before booking, so a model-invented time is refused.
Without a key, the old numbered-menu flow runs (book only; responses say `mode: "guided"`).

Each clinic picks one of two flows (`confirmationPolicy`, via `PUT /v1/admin/settings`):

| | `instant` — direct booking | `staff_approval` — doctor accepts |
|---|---|---|
| Times offered | Only times free on the doctor's Google Calendar | Same |
| On booking | Appointment is CONFIRMED and blocks the calendar | Appointment is a request; slot is held as a tentative `[Pending]` calendar event |
| Doctor | Gets an FYI WhatsApp message | Gets a request and replies `APPROVE <ref>` or `REJECT <ref> <reason>` |
| Patient | Told it is confirmed | Told it is awaiting the doctor; messaged when accepted/declined |

Settings: `GET/PUT /v1/admin/settings` (`confirmationPolicy`, `staffWhatsappNumber`, `reminderHoursBefore`
(0 = off), `faqText`, `whatsappPhoneNumberId`). Patients can cancel/reschedule in chat; on WhatsApp their number
is the identity, on web they give their phone + the 6-character booking reference.

**Doctor's WhatsApp commands** (only from `staffWhatsappNumber`): `APPROVE <ref>`, `REJECT <ref> <reason>`,
`CANCEL <ref> <reason>`, `PENDING`, `CONNECT` (sends a 20-minute link to connect Google Calendar).

**Background loop** ([`src/jobs/scheduler.ts`](src/jobs/scheduler.ts), every 5 min): polls each connected calendar so a
deleted event cancels the appointment and a moved event moves it (patient is told either way); retries failed
calendar syncs; sends reminders. Free-text WhatsApp messages only reach people who wrote in the last 24h, so set
`WHATSAPP_NOTIFY_TEMPLATE` for reminders/approval requests outside that window.

Re-apply `db/schema.sql` after pulling these changes (idempotent). It also merges the duplicate `patients` rows the old
one-row-per-booking model created, by phone number.

## Connecting a real Google Calendar

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a
   project, enable the **Google Calendar API**, and create an **OAuth 2.0
   Client ID** of type "Web application".
2. Add `http://localhost:4000/auth/google/callback` as an authorized redirect URI.
3. Put the client ID/secret into `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
4. Restart the server, then have the doctor send `CONNECT` from the staff WhatsApp number (or call
   `GET /v1/admin/resources/<id>/connect-link` with your bearer token) and open the link.
5. Approve the consent screen. Future bookings for that resource will now
   check real Google Calendar busy time and create real events.

> If Google doesn't return a refresh token, you've likely already granted this
> app access before. Remove it at https://myaccount.google.com/permissions
> and try again — Google only issues a refresh token on first consent.

## Connecting the WhatsApp bot

1. Create a Meta developer account and a WhatsApp Business app at
   [developers.facebook.com](https://developers.facebook.com/).
2. Get a test phone number and a temporary (or permanent) access token.
3. Set `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN` (any string you pick),
   and `WHATSAPP_APP_SECRET` in `.env`.
4. Expose your local server publicly for the webhook, e.g. with `ngrok`:
   ```bash
   ngrok http 4000
   ```
5. In the Meta app's WhatsApp > Configuration page, set the webhook URL to
   `https://<your-ngrok-domain>/v1/webhooks/whatsapp` and the verify token to
   match `WHATSAPP_VERIFY_TOKEN`.
6. Run this SQL to map the test phone number to your tenant:
   ```sql
   UPDATE tenants SET whatsapp_phone_number_id = '<phone_number_id_from_meta>' WHERE slug = 'demo-clinic';
   ```
7. Message the test number from WhatsApp — you should get the same guided
   booking flow as the web widget.

## Adding a second clinic

No code changes needed:

```sql
INSERT INTO tenants (name, slug, timezone, confirmation_policy, whatsapp_phone_number_id)
VALUES ('Second Clinic', 'second-clinic', 'Asia/Kolkata', 'instant', '<their whatsapp phone number id>');
-- then insert services/resources/availability_rules the same way db/seed.sql does for demo-clinic
```

Their website embeds `<script src=".../widget.js" data-tenant="second-clinic" defer></script>`,
and their owner goes through their own `/auth/google/connect` flow for their
own resource — nothing is ever shared between tenants.

## Project layout

```
db/            schema.sql (apply once), seed.sql (demo data)
src/
  index.ts          entry point: wires Express, routes, scheduler
  config.ts         env parsing + lazy validation
  types.ts, errors.ts   shared types and error classes
  lib/              db pool, crypto, phone normalisation, rate limiting
  booking/          booking.ts (slot generation, conflict-safe create/reschedule, state machine), tenant.ts
  calendar/         googleCalendar.ts (OAuth, freebusy, event sync), calendarPoll.ts (inbound changes)
  channels/         whatsapp.ts (Cloud API + signature check), notify.ts, staffCommands.ts
  chat/             guidedFlow.ts (deterministic menu), agent.ts + agentTools.ts (Gemini tool loop),
                    gemini.ts, conversation.ts (dispatcher), conversationStore.ts
  http/             auth.ts (JWT + requireAuth), openapi.ts, routes/ (thin Express handlers)
  jobs/             scheduler.ts (reminders, calendar polling, sync retry)
  __tests__/        vitest suites
public/
  widget.js               the embeddable snippet clinics paste into their own site
  widget/chat.html, chat.js, style.css   the chat UI, served in an iframe from this server
  admin.html, admin.js    staff dashboard
```

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

- Consultant dashboard: http://localhost:4000/consultant/ (after `npm run build:all`, see below)
- Admin console: http://localhost:4000/admin/ (needs `ADMIN_TOKEN` in `.env`)
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
book an appointment. It'll show up in the consultant dashboard for approval
(the demo tenant uses `staff_approval` policy).

### The dashboards (React)

Two React + TypeScript + Vite apps live in [`web/`](web/) (an npm workspace, so `npm install` at the root covers them). The API server serves their build:

| App | URL | Who | Sign-in |
|---|---|---|---|
| Consultant dashboard | **`/consultant/`** | A clinic's team | Email + password (`/v1/consultant/login`) |
| Admin console | **`/admin/`** | The platform operator | Paste the `ADMIN_TOKEN` from `.env` |

```bash
npm run build:all   # server (tsc) + both dashboards (Vite -> web/dist, gitignored)
npm start           # then open http://localhost:4000/consultant/ or /admin/
```

Both apps use the same light theme as the marketing website (Geist, green accent). `npm run dev` and `npm start` build the dashboards first when they're missing or out of date (skip with `SKIP_WEB_BUILD=1`), and `http://localhost:4000/` is a landing page linking to the consultant dashboard, the admin console and the API docs.

While working on the UI, run the API (`npm run dev`) and `npm run dev:web` side by side; Vite serves the apps on http://localhost:5173/consultant/ and /admin/ and proxies `/v1` to the API (set `API_URL` if the API isn't on port 4000). The old `/consultant.html` redirects to `/consultant/`.

**Consultant dashboard** — Overview (today / next 7 days / needs approval / users / revenue, plus a first-run setup checklist), Appointments (filter, search, approve, reject or cancel with a reason, **reschedule to any date and time with a date-time picker** that warns about working hours and blocks overlaps, CSV export), Users (search, history), Services, Practitioners (working hours, holidays, Google Calendar connect), Payments (fees and transactions), Settings (booking flow, timezone, **time slot interval**, WhatsApp, reminders, FAQ, password).

**Admin console** — platform overview, list and onboard consultants (with their first login), edit a consultant, manage its logins, and set up its Razorpay payments (credentials, enable/disable, webhook URL to register).

### Time slot interval

How often a start time is offered is a per-consultant setting (**Settings → Scheduling**, or `slotIntervalMinutes` in `PUT /v1/consultant/settings`): **5 minutes by default**, any value from 5 to 240. With 5, a day offers 9:00, 9:05, 9:10…; with 30, 9:00, 9:30… The chat assistant shows a handful of well-spread times per day and can search near a time ("around 5pm"); the dashboard's reschedule picker steps by the same interval.

## 6. Run tests

```bash
npm test
```

This runs the pure unit tests (slot generation, state machine — no DB needed)
plus the concurrency integration test (needs `DATABASE_URL_TEST` set up per
step 4 above) that proves two simultaneous bookings for the same time slot
can't both succeed. `npm run test:web` runs the React dashboard's tests (jsdom, no server needed).

## Swagger UI: try the agent and watch what it does

`npm run dev`, then open **http://localhost:4000/docs** (raw spec: `/openapi.json`).

- **`POST /v1/public/{tenantSlug}/chat/messages`** — talk to the agent (`tenantSlug = demo-clinic`; reuse a `sessionId`
  to continue, `DELETE …/chat/sessions/{sessionId}` to reset).
  - `?stream=false` (default): one JSON reply. `?stream=true`: Server-Sent Events (`text_delta` as the model writes, then `done`).
  - `?trace=true`: also returns what the agent did — each `tool_call` (name + arguments), its `tool_result`, and the model's text per step.
    In a stream these arrive as `tool_call` / `tool_result` / `model_text` events. Swagger UI buffers SSE, so it shows the full
    ordered log when the turn ends; use `curl -N` to watch live.
- **`GET …/agent/info`** — the exact system prompt and tool definitions for the clinic.
- Try both flows: `POST /v1/consultant/login` → **Authorize** → `PUT /v1/consultant/settings` (`instant` vs `staff_approval`) → book via chat → approve under *consultant*.

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
  phone doesn't rename the profile. Consultants can look their users up with `GET /v1/consultant/users?phone=…` and
  `GET /v1/consultant/users/{id}`.

## The agent and the two booking flows

With `GEMINI_API_KEY` set, a Gemini agent ([`src/chat/agent.ts`](src/chat/agent.ts)) talks to patients on WhatsApp and the
web widget: it books, lists, reschedules and cancels appointments and answers questions from the clinic's FAQ
text. It can only act through the tools in [`src/chat/agentTools.ts`](src/chat/agentTools.ts), which call `booking.ts` —
the only code that changes appointments. The tools re-check every slot against clinic hours, existing
bookings and the doctor's live Google free/busy before booking, so a model-invented time is refused.
Without a key, the old numbered-menu flow runs (book only; responses say `mode: "guided"`).

Each clinic picks one of two flows (`confirmationPolicy`, via `PUT /v1/consultant/settings`):

| | `instant` — direct booking | `staff_approval` — doctor accepts |
|---|---|---|
| Times offered | Only times free on the doctor's Google Calendar | Same |
| On booking | Appointment is CONFIRMED and blocks the calendar | Appointment is a request; slot is held as a tentative `[Pending]` calendar event |
| Doctor | Gets an FYI WhatsApp message | Gets a request and replies `APPROVE <ref>` or `REJECT <ref> <reason>` |
| Patient | Told it is confirmed | Told it is awaiting the doctor; messaged when accepted/declined |

Settings: `GET/PUT /v1/consultant/settings` (`confirmationPolicy`, `staffWhatsappNumber`, `reminderHoursBefore`
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

### How the agent handles times

- **Clinic time, always.** The agent gives tools a `date` and a 24-hour `time` ("1:30 PM" → `13:30`), and the server converts it in the clinic's own time zone — the model never writes a UTC offset. An offset-less timestamp is read as clinic time.
- **A calendar in the prompt.** The next 15 days are listed with their weekdays, so "next Tuesday" or "the 12th" is a lookup, not arithmetic. Times are read back as "Monday 5 October at 1:30 PM".
- **It sees every free time, not a sample.** `get_available_slots` returns a few well-spread times plus the full free *ranges* and the interval; `check_time` answers "is 1:30 PM free?" for any specific time.
- **"Unavailable" always has a reason.** `booked`, `outside_hours`, `closed_day`, `too_soon`, `past`, `too_close` (the clinic's buffer), or `not_on_interval` — each with the nearest free times, spaced apart so they're real choices.
- **Resilient.** A transient model failure (empty reply, 429/5xx, timeout) is retried once before the patient sees an error.

## Connecting a real Google Calendar

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a
   project, enable the **Google Calendar API**, and create an **OAuth 2.0
   Client ID** of type "Web application".
2. Add `http://localhost:4000/auth/google/callback` as an authorized redirect URI.
3. Put the client ID/secret into `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
4. Restart the server, then have the doctor send `CONNECT` from the staff WhatsApp number (or call
   `GET /v1/consultant/resources/<id>/connect-link` with your bearer token) and open the link.
5. Approve the consent screen. Future bookings for that resource will now
   check real Google Calendar busy time and create real events.

> If Google doesn't return a refresh token, you've likely already granted this
> app access before. Remove it at https://myaccount.google.com/permissions
> and try again — Google only issues a refresh token on first consent.

## Connecting WhatsApp

Two ways to give a consultant a WhatsApp number. They can coexist.

### A. The consultant connects their own number (Embedded Signup)

Users chat with the **clinic's own number**, under the clinic's name. The consultant opens **WhatsApp** in their dashboard, clicks *Connect WhatsApp number*, signs in with Facebook and picks or adds a number. The platform then stores that consultant's business token (encrypted), registers the number, subscribes your webhook to their WhatsApp account, and creates a generic message template (`booking_update`) in their account. Their messages go out with **their** token; nobody shares one.

Setup, once, by the platform operator in the [Meta developer console](https://developers.facebook.com/):

1. Use (or create) a **Business** app with the **WhatsApp** product and **Facebook Login for Business**.
2. Facebook Login for Business → **Configurations** → create one from the *WhatsApp Embedded Signup* template (permissions `whatsapp_business_management` and `whatsapp_business_messaging`). Copy its **Configuration ID**.
3. App settings → Basic: copy the **App ID** and **App secret**. Facebook Login settings: enable *Login with the JavaScript SDK* and add your site's HTTPS domain to *Allowed domains for the JavaScript SDK*.
4. In `.env`:
   ```
   META_APP_ID=<app id>
   WHATSAPP_APP_SECRET=<app secret>
   META_EMBEDDED_SIGNUP_CONFIG_ID=<configuration id>
   WHATSAPP_VERIFY_TOKEN=<any string>
   ```
5. WhatsApp → Configuration: set the **one** webhook for the app to `https://<your-domain>/v1/webhooks/whatsapp` (verify token as above), subscribed to the **messages** field. It serves every connected consultant. For local work, use a tunnel (`ngrok http 4000`); the signup popup also needs an HTTPS page.

Things to know:
- **Development vs live.** While your Meta app is in development mode, only people with a role on the app can complete sign-up. Letting outside clinics connect requires Meta's **App Review** (advanced access to the two WhatsApp permissions), **business verification** and Tech Provider onboarding. Meta's requirements change; follow its current Embedded Signup documentation. This flow has been tested against a simulated Meta API, not a live app.
- **The number.** It must be able to receive an SMS or call to verify. A number that's active on the regular WhatsApp / WhatsApp Business app **stops working there** once it moves to the Cloud API (Meta's *coexistence* option exists for some business-app numbers; check availability for your country). Use a spare or new number, not a personal one.
- **Templates.** Reminders, approval requests and web-chat verification codes are sent outside WhatsApp's 24-hour window, so they use the `booking_update` template. Meta reviews it (usually minutes); the WhatsApp page shows its status. Replies to someone who just messaged work immediately.
- **If a step fails** (e.g. registering the number), the connection is kept and the page shows what went wrong with a *Retry setup* button.
- **Disconnecting** stops incoming messages and deletes the stored token. The number itself stays in the consultant's own WhatsApp account.

### B. A number the platform operator owns (also Meta's test number)

1. Get a test or production number and an access token in the Meta console; set `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN` and `WHATSAPP_APP_SECRET` in `.env`.
2. Register the webhook as in step 5 above.
3. In the **admin console**, open the consultant → Profile → *WhatsApp phone number id* (consultants can't set this themselves).
4. Optional `WHATSAPP_NOTIFY_TEMPLATE`: an approved template used outside the 24-hour window. Its body needs fixed text around the variable (for example `Update from your clinic: {{1}}. Reply here to book or cancel.`): Meta rejects a body that is only `{{1}}`.

Meta's test number can only message numbers you add to its allowed list, and the temporary token expires in about 24 hours.

**Seeing delivery results.** "accepted" from Meta doesn't mean "delivered". With the webhook subscribed to `messages`, the server logs each message's outcome, with Meta's error code and a hint:
```
[whatsapp] message …NjQ1OUZBAA== to +918861123860 FAILED (code 131049): …
  → Meta chose not to deliver (its per-user marketing/engagement limits)…
```

## Who is who

| Role | Who | API | UI |
|---|---|---|---|
| **Admin** | The platform operator | `/v1/admin/*`, authenticated with `ADMIN_TOKEN` | Admin console at `/admin/` (or Swagger `/docs`) |
| **Consultant** | A clinic or any similar appointment-based place, and its team | `/v1/consultant/*`, JWT from `POST /v1/consultant/login` | Dashboard at `/consultant/` |
| **User** | The end user who chats and books, on the web widget or WhatsApp | `/v1/public/*` (no login; identified by phone number) | Chat widget |

## Payments (Razorpay)

Off by default, and off for a consultant until the **admin** turns it on for that consultant:

1. Set `ADMIN_TOKEN` in `.env` (any long random string) and restart.
2. **Admin** stores the consultant's Razorpay keys (verified against Razorpay, encrypted at rest with `CRYPTO_KEY`). In the admin console: *Consultants → the consultant → Payments*. Or with the API:
   ```bash
   curl -X PUT localhost:4000/v1/admin/tenants/demo-clinic/payments \
     -H "Authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
     -d '{"enabled":true,"razorpayKeyId":"rzp_test_...","razorpayKeySecret":"...","razorpayWebhookSecret":"..."}'
   ```
   The response contains a `webhookUrl`; register it in the consultant's Razorpay dashboard (Settings → Webhooks) for the `payment_link.paid` event, using the same webhook secret.
3. **The consultant** sets their fees in the dashboard ("Consultation fees") or via `PUT /v1/consultant/payments`:
   - `flat` — one hourly rate at all times.
   - `variable` — separate hourly rates for weekdays (Mon–Fri), weekends (Sat–Sun) and nights (default 20:00–06:00, crossing midnight; night overrides weekday/weekend).

   Rates are **₹ per hour, prorated by the service's duration** (₹1000/hr → a 30-minute consultation costs ₹500). The appointment's **start time**, in the clinic's timezone, picks the rate. `GET /v1/consultant/payments/quote` shows what any slot would cost.
4. From then on, booking in the chat only **holds** the slot (`AWAITING_PAYMENT`, blocking double-booking like any booking) and sends a Razorpay payment link: a **Pay** button in the web widget, a link in the message on WhatsApp. Payment then confirms the booking (instant clinics) or sends it to the doctor (approval clinics). Staff only see a request after it's paid. Unpaid holds are released after `PAYMENT_HOLD_MINUTES` (default 20) by the scheduler.

Payments are confirmed by the webhook, and also by polling Razorpay (the widget polls, the agent has a `check_payment_status` tool, the scheduler sweeps stale holds), so a missed webhook doesn't strand a paid booking.

**Not handled yet:** refunds. If the doctor rejects or a clinic cancels a paid booking, refund it in the Razorpay dashboard. A payment that lands for a booking that was already released is recorded and the clinic is alerted on WhatsApp to refund it.

## Adding a consultant (clinic)

The **admin** onboards consultants. In the admin console choose *New consultant*: name, slug, timezone, booking flow and the first login (a password is generated for you to hand over). Or call `POST /v1/admin/tenants`. Nothing is shared between consultants.

The consultant then signs in at `/consultant/` and sets themselves up: **Services**, **Practitioners** with their **working hours**, optionally a Google Calendar, and **Settings** (the dashboard's Overview shows a checklist until this is done). Admins can add more logins for a consultant's team under *Consultants → Logins*; an email can belong to only one consultant.

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
  payments/         pricing.ts (flat / weekday-weekend-night fees), razorpay.ts (Payment Links client), store.ts,
                    checkout.ts (create/void links), settlement.ts (confirm on payment, reconcile, expire holds), offer.ts
  calendar/         googleCalendar.ts (OAuth, freebusy, event sync), calendarPoll.ts (inbound changes)
  channels/         whatsapp.ts (Cloud API + signature check), notify.ts, staffCommands.ts
  chat/             guidedFlow.ts (deterministic menu), agent.ts + agentTools.ts + paymentTools.ts + toolKit.ts (Gemini tool loop),
                    gemini.ts, conversation.ts (dispatcher), conversationStore.ts
  http/             auth.ts (consultant JWT + requireAuth), openapi.ts, routes/ (thin Express handlers:
                    admin.ts, consultant.ts, consultantPayments.ts, webChat.ts for users, webhooks)
  jobs/             scheduler.ts (reminders, calendar polling, sync retry)
  __tests__/        vitest suites
web/                      React + TypeScript dashboards (Vite): consultant/ and admin/ pages, shared UI in src/shared. Builds to web/dist
public/
  widget.js               the embeddable snippet clinics paste into their own site
  widget/chat.html, chat.js, style.css   the chat UI, served in an iframe from this server
```

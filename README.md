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
- **No background worker.** Calendar sync happens synchronously right after a
  booking is created/changed. If it fails, the appointment is saved with
  `calendar_sync_status = 'failed'` and staff can hit **Retry sync** in the
  dashboard — there's no automatic retry loop.
- **No fine-grained roles.** Any row in `staff_users` can do anything for its
  tenant. No permissions, no password reset, no rate limiting on login.
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

## Enabling free-text understanding (optional)

By default the bot only understands numbered replies or button clicks — no AI,
no API cost, nothing that can misread a date. This matches the BRD's own
pilot recommendation and is what runs if you leave `GEMINI_API_KEY` blank.

If you want patients to be able to type naturally ("next Tuesday afternoon
for a cleaning") instead of always replying with a number, set
`GEMINI_API_KEY` (from https://aistudio.google.com/apikey) in `.env`. This adds
exactly one thing: when a reply doesn't match a number or button id,
[`src/ai.ts`](src/ai.ts) asks Gemini to pick the closest match from the
*same* list of options the booking engine already generated. The model never
talks to the database, never invents an option that wasn't offered, and never
creates a booking itself — `src/booking.ts` remains the only thing that can do
that, and it doesn't know or care whether a reply was resolved by number or by
AI. If the API call fails or the model isn't confident, it's treated exactly
like an unrecognized reply (the bot re-prompts) — nothing breaks.

## Connecting a real Google Calendar

1. In the [Google Cloud Console](https://console.cloud.google.com/), create a
   project, enable the **Google Calendar API**, and create an **OAuth 2.0
   Client ID** of type "Web application".
2. Add `http://localhost:4000/auth/google/callback` as an authorized redirect URI.
3. Put the client ID/secret into `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
4. Restart the server, log into the staff dashboard, find the resource's id
   (`GET /v1/admin/resources` with your bearer token), and visit:
   `http://localhost:4000/auth/google/connect?resourceId=<id>` while logged in.
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
  booking.ts        core engine: slot generation, conflict-safe create/reschedule, state machine
  googleCalendar.ts real Google OAuth + freebusy + event sync
  guidedFlow.ts     one conversation engine shared by both chat channels
  whatsapp.ts       WhatsApp Cloud API send + webhook signature check
  auth.ts           staff login (JWT) + requireAuth middleware
  tenant.ts         loads a tenant's validated config (services/resources/hours)
  routes/           thin Express route handlers per concern
public/
  widget.js               the embeddable snippet clinics paste into their own site
  widget/chat.html, chat.js, style.css   the chat UI, served in an iframe from this server
  admin.html, admin.js    staff dashboard
```

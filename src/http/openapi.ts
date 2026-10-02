// OpenAPI 3.0 description of the service, served at /openapi.json and rendered by Swagger UI at /docs.
// Hand-written (not generated) so it can explain the agent's behaviour, not just the shapes.

const json = (schema: object, description = "OK") => ({ description, content: { "application/json": { schema } } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const errorResponse = (description: string) => json(ref("Error"), description);
const bearer = [{ bearerAuth: [] }];
const idParam = (description = "Appointment id (uuid)") => ({
  name: "id", in: "path", required: true, description, schema: { type: "string", format: "uuid" },
});
const tenantParam = {
  name: "tenantSlug", in: "path", required: true, description: "Clinic slug", schema: { type: "string", example: "demo-clinic" },
};

const sseExample = `event: tool_call
data: {"type":"tool_call","step":0,"name":"get_available_slots","args":{"serviceId":"…","partOfDay":"afternoon"}}

event: tool_result
data: {"type":"tool_result","step":0,"name":"get_available_slots","result":{"slots":[{"local":"Tue 06 Oct 2026, 14:00"}]},"durationMs":412}

event: text_delta
data: {"step":1,"text":"I have Tuesday at 2:00 PM"}

event: text_delta
data: {"step":1,"text":" with Dr. Demo. Shall I book it?"}

event: done
data: {"replyText":"I have Tuesday at 2:00 PM with Dr. Demo. Shall I book it?","mode":"agent"}
`;

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Clinic Booking Agent API",
    version: "0.2.0",
    description: `A Gemini-powered booking agent for clinics, on WhatsApp and an embeddable web chat, backed by Postgres and Google Calendar.

## Who is who
- **Admin** — the platform operator. Uses \`/v1/admin/*\` with the \`ADMIN_TOKEN\`. Onboards consultants and enables their Razorpay payments.
- **Consultants** — clinics or any similar appointment-based place. Their team logs in at \`/v1/consultant/login\` and uses \`/v1/consultant/*\` (dashboard at \`/consultant/\`) for bookings, settings and fees.
- **Users** — the end users who chat and book, over the web widget or WhatsApp (\`/v1/public/*\`). A user is identified by phone number; there is no registration.

## Try the agent here
1. Open **POST /v1/public/{tenantSlug}/chat/messages**, click *Try it out*, keep \`tenantSlug = demo-clinic\`, and send a message. Reuse the same \`sessionId\` to continue a conversation; use **DELETE …/chat/sessions/{sessionId}** to start over.
2. \`trace=true\` adds what the agent did: each **tool call** it made, the **result** it got back, and its text — so you can see it consult the calendar, ask you to confirm, then book.
3. \`stream=true\` returns Server-Sent Events as the model writes. **Swagger UI buffers SSE**, so it shows the complete ordered event log once the turn finishes; to watch it live use \`curl -N\`.
4. **GET …/agent/info** shows the system prompt and the tools the agent can use.

## Patients are identified by phone number — there is no registration
- **WhatsApp:** the sender's number (signed by Meta) *is* the identity. The first message creates the patient automatically, with the WhatsApp profile name, and the agent saves further details (name, email, date of birth, language) as the patient mentions them.
- **Web chat:** a visitor proves their number with a one-time code sent over WhatsApp — via the agent (it calls \`send_phone_otp\` / \`verify_phone_otp\`) or the **phone/otp** and **phone/verify** endpoints. Until then nothing stored about that number is revealed or changeable, and the agent can't book. You may pass \`phone\`/\`name\` in the chat request to capture a contact immediately (unverified).
- With WhatsApp not configured (local dev), the code is returned as \`devCode\` so you can finish the flow here.
- Consultants can look their users up under **consultant → users**.

## The two booking flows (per clinic, \`confirmationPolicy\`)
- \`instant\` — direct booking: only times free on the doctor's Google Calendar are offered; booking confirms and blocks the calendar.
- \`staff_approval\` — the booking is a request until the doctor explicitly accepts it (WhatsApp \`APPROVE <ref>\` or the *approve* endpoint below).

Try it end to end: log in via **/v1/consultant/login** (demo: \`owner@demo-clinic.test\` / \`password123\`), press **Authorize**, switch the flow with **PUT /v1/consultant/settings**, book through the chat, then approve under **consultant**.

## Payments (Razorpay) — off unless the admin turns it on for a consultant
1. **Admin** (\`ADMIN_TOKEN\`) calls **PUT /v1/admin/tenants/{slug}/payments** with the consultant's Razorpay key id/secret and webhook secret. Nothing below works until this is done, and consultants cannot do it.
2. **Consultants** set their fees with **PUT /v1/consultant/payments**: \`flat\` (one hourly rate) or \`variable\` (weekday / weekend / night hourly rates). A service's fee is the hourly rate prorated by its duration. They also switch \`collectPayments\` on or off.
3. With payments active, booking only **holds** the slot (\`AWAITING_PAYMENT\`) and the patient gets a Razorpay payment link — in the chat \`payment\` field on the web, as a link in the message on WhatsApp. Paying confirms the booking (or sends it to the doctor, per the clinic's flow). Unpaid holds are released after \`PAYMENT_HOLD_MINUTES\`.
4. Register the \`webhookUrl\` from step 1 in Razorpay (event \`payment_link.paid\`). Without a webhook the chat still confirms payments by polling Razorpay.

Without \`GEMINI_API_KEY\` the service runs a plain numbered-menu flow instead of the agent (\`mode: "guided"\`).`,
  },
  servers: [{ url: "/" }],
  tags: [
    { name: "agent", description: "User-facing chat (what the web widget calls)" },
    { name: "consultant", description: "Consultant API: a clinic (or similar place) managing its own bookings, fees and settings (bearer token from /v1/consultant/login)" },
    { name: "admin", description: "Admin API: the platform operator onboarding consultants and enabling their payments (ADMIN_TOKEN)" },
    { name: "payments", description: "Razorpay webhook" },
    { name: "google", description: "Google Calendar connection" },
    { name: "whatsapp", description: "Meta WhatsApp Cloud API webhook" },
    { name: "system" },
  ],
  paths: {
    "/health": {
      get: { tags: ["system"], summary: "Liveness + DB check", responses: { 200: json({ type: "object", properties: { status: { type: "string", example: "ok" } } }), 503: errorResponse("Database unreachable") } },
    },

    "/v1/public/{tenantSlug}/chat/messages": {
      post: {
        tags: ["agent"],
        summary: "Send a patient message to the agent",
        description: "Runs one conversation turn. The agent may call tools (check slots, book, cancel…) before replying.",
        parameters: [
          tenantParam,
          { name: "stream", in: "query", description: "`true` streams Server-Sent Events; `false` returns one JSON body.", schema: { type: "string", enum: ["true", "false"], default: "false" } },
          { name: "trace", in: "query", description: "`true` includes the agent's tool calls/results (disabled when the server has AGENT_TRACE off, e.g. production).", schema: { type: "string", enum: ["true", "false"], default: "true" } },
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: ref("ChatRequest"),
              examples: {
                book: { summary: "Start a booking", value: { sessionId: "swagger-demo-1", message: "Hi, I'd like a general consultation tomorrow afternoon" } },
                confirm: { summary: "Confirm", value: { sessionId: "swagger-demo-1", message: "Yes please, my name is Asha Rao and my number is +91 98765 43210" } },
                faq: { summary: "Ask a question", value: { sessionId: "swagger-demo-1", message: "What are your opening hours?" } },
              },
            },
          },
        },
        responses: {
          200: {
            description: "Agent reply (JSON when stream=false, SSE when stream=true)",
            content: {
              "application/json": { schema: ref("ChatResponse") },
              "text/event-stream": {
                schema: { type: "string", description: "Events: `text_delta`, `tool_call`, `tool_result`, `model_text` (the last three only with trace=true), then `done` (same body as the JSON response) or `error`." },
                example: sseExample,
              },
            },
          },
          400: errorResponse("Bad request (e.g. stream is not true/false)"),
          403: errorResponse("trace requested but disabled on this server"),
          404: errorResponse("Unknown clinic"),
          429: errorResponse("Too many requests"),
        },
      },
    },
    "/v1/public/{tenantSlug}/chat/sessions/{sessionId}": {
      delete: {
        tags: ["agent"],
        summary: "Forget a conversation",
        description: "Deletes the stored history for a web session so you can start fresh.",
        parameters: [tenantParam, { name: "sessionId", in: "path", required: true, schema: { type: "string", example: "swagger-demo-1" } }],
        responses: { 204: { description: "Deleted" }, 404: errorResponse("Unknown clinic") },
      },
    },
    "/v1/public/{tenantSlug}/chat/sessions/{sessionId}/phone/otp": {
      post: {
        tags: ["agent"],
        summary: "Send a phone-verification code (web)",
        description: "Captures the number as an unverified contact and sends a 6-digit code over WhatsApp (valid 10 min, max 3 per hour per number). In dev without WhatsApp the code comes back as `devCode`.",
        parameters: [tenantParam, { name: "sessionId", in: "path", required: true, schema: { type: "string", example: "swagger-demo-1" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["phone"], properties: { phone: { type: "string", example: "+91 98765 43210" } } } } } },
        responses: {
          200: json({ type: "object", properties: { sent: { type: "boolean" }, devCode: { type: "string", description: "Dev only" }, note: { type: "string" } } }),
          400: errorResponse("Invalid phone"),
          502: json({ type: "object", properties: { sent: { type: "boolean", example: false }, error: { type: "string" } } }, "Could not deliver the code"),
          429: errorResponse("Too many requests"),
        },
      },
    },
    "/v1/public/{tenantSlug}/chat/sessions/{sessionId}/phone/verify": {
      post: {
        tags: ["agent"],
        summary: "Verify the code and bind the session to the phone number",
        description: "After success this web session may book, list, reschedule and cancel that number's appointments and the agent sees its saved details. 5 wrong attempts invalidate the code.",
        parameters: [tenantParam, { name: "sessionId", in: "path", required: true, schema: { type: "string", example: "swagger-demo-1" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["phone", "code"], properties: { phone: { type: "string", example: "+91 98765 43210" }, code: { type: "string", example: "123456" } } } } } },
        responses: {
          200: json({ type: "object", properties: { verified: { type: "boolean" }, patient: { type: "object", properties: { name: { type: "string", nullable: true }, email: { type: "string", nullable: true }, preferredLanguage: { type: "string", nullable: true }, phone: { type: "string" } } } } }),
          401: json({ type: "object", properties: { verified: { type: "boolean", example: false }, error: { type: "string" } } }, "Wrong or expired code"),
        },
      },
    },
    "/v1/public/{tenantSlug}/agent/info": {
      get: {
        tags: ["agent"],
        summary: "How the agent is configured for this clinic",
        description: "Returns the mode, model, booking flow, the exact system prompt and the tool declarations. Dev only (AGENT_TRACE).",
        parameters: [tenantParam],
        responses: { 200: json(ref("AgentInfo")), 403: errorResponse("Disabled on this server"), 404: errorResponse("Unknown clinic") },
      },
    },

    "/v1/consultant/login": {
      post: {
        tags: ["consultant"],
        summary: "Consultant login",
        description: "Returns a bearer token. Copy it into **Authorize**.",
        requestBody: { required: true, content: { "application/json": { schema: ref("LoginRequest"), example: { email: "owner@demo-clinic.test", password: "password123" } } } },
        responses: { 200: json({ type: "object", properties: { token: { type: "string" } } }), 401: errorResponse("Invalid credentials"), 429: errorResponse("Too many attempts") },
      },
    },
    "/v1/consultant/settings": {
      get: { tags: ["consultant"], summary: "Get clinic settings", security: bearer, responses: { 200: json({ type: "object", properties: { settings: ref("Settings") } }), 401: errorResponse("Unauthorized") } },
      put: {
        tags: ["consultant"],
        summary: "Update clinic settings — choose the booking flow here",
        security: bearer,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: ref("SettingsPatch"),
              examples: {
                direct: { summary: "Flow 1: direct booking", value: { confirmationPolicy: "instant" } },
                approval: { summary: "Flow 2: doctor must accept", value: { confirmationPolicy: "staff_approval", staffWhatsappNumber: "+91 98765 43210" } },
              },
            },
          },
        },
        responses: {
          200: json({ type: "object", properties: { settings: ref("Settings"), warnings: { type: "array", items: { type: "string" } } } }),
          400: errorResponse("Validation error"),
          401: errorResponse("Unauthorized"),
        },
      },
    },
    "/v1/consultant/appointments": {
      get: {
        tags: ["consultant"],
        summary: "List appointments",
        security: bearer,
        parameters: [{ name: "status", in: "query", schema: { type: "string", enum: ["AWAITING_PAYMENT", "PENDING_CONFIRMATION", "CONFIRMED", "REJECTED", "CANCELLED", "COMPLETED"] } }],
        responses: { 200: json({ type: "object", properties: { appointments: { type: "array", items: ref("Appointment") } } }), 401: errorResponse("Unauthorized") },
      },
    },
    "/v1/consultant/appointments/{id}/approve": {
      post: { tags: ["consultant"], summary: "Doctor accepts a pending request", description: "Confirms it, turns the tentative calendar hold into a confirmed event and messages the patient.", security: bearer, parameters: [idParam()], responses: { 200: json({ type: "object", properties: { appointment: ref("Appointment") } }), 400: errorResponse("Not pending"), 404: errorResponse("Not found") } },
    },
    "/v1/consultant/appointments/{id}/reject": {
      post: { tags: ["consultant"], summary: "Doctor declines a pending request", security: bearer, parameters: [idParam()], requestBody: { content: { "application/json": { schema: { type: "object", properties: { reason: { type: "string" } } }, example: { reason: "Doctor is on leave that day" } } } }, responses: { 200: json({ type: "object", properties: { appointment: ref("Appointment") } }), 400: errorResponse("Not pending") } },
    },
    "/v1/consultant/appointments/{id}/cancel": {
      post: { tags: ["consultant"], summary: "Cancel an appointment", security: bearer, parameters: [idParam()], requestBody: { content: { "application/json": { schema: { type: "object", properties: { reason: { type: "string" } } } } } }, responses: { 200: json({ type: "object", properties: { appointment: ref("Appointment") } }), 400: errorResponse("Cannot cancel in this status") } },
    },
    "/v1/consultant/appointments/{id}/reschedule": {
      post: { tags: ["consultant"], summary: "Move an appointment", security: bearer, parameters: [idParam()], requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["startAt"], properties: { startAt: { type: "string", format: "date-time" } } } } } }, responses: { 200: json({ type: "object", properties: { appointment: ref("Appointment") } }), 409: errorResponse("Slot taken") } },
    },
    "/v1/consultant/appointments/{id}/retry-sync": {
      post: { tags: ["consultant"], summary: "Retry a failed Google Calendar sync", security: bearer, parameters: [idParam()], responses: { 200: json({ type: "object", properties: { appointment: ref("Appointment") } }) } },
    },
    "/v1/consultant/users": {
      get: {
        tags: ["consultant"],
        summary: "Find users",
        description: "Profiles are created automatically from the first message. Look one up by phone (any format; normalised) or search name/email/number.",
        security: bearer,
        parameters: [
          { name: "phone", in: "query", schema: { type: "string", example: "+91 98765 43210" } },
          { name: "q", in: "query", description: "Substring of name, email or phone", schema: { type: "string" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 25, maximum: 100 } },
        ],
        responses: { 200: json({ type: "object", properties: { users: { type: "array", items: ref("User") } } }), 401: errorResponse("Unauthorized") },
      },
    },
    "/v1/consultant/users/{id}": {
      get: { tags: ["consultant"], summary: "A user with their appointment history", security: bearer, parameters: [idParam("Patient id (uuid)")], responses: { 200: json({ type: "object", properties: { user: ref("User"), appointments: { type: "array", items: { type: "object" } } } }), 404: errorResponse("Not found") } },
    },
    "/v1/consultant/resources": {
      get: { tags: ["consultant"], summary: "List practitioners (and Google connection status)", security: bearer, responses: { 200: json({ type: "object", properties: { resources: { type: "array", items: { type: "object" } } } }) } },
    },
    "/v1/consultant/resources/{id}/connect-link": {
      get: { tags: ["consultant", "google"], summary: "Get a 20-minute link for a doctor to connect Google Calendar", security: bearer, parameters: [idParam("Resource (practitioner) id")], responses: { 200: json({ type: "object", properties: { url: { type: "string" }, expiresInMinutes: { type: "integer" } } }), 400: errorResponse("Google not configured") } },
    },

    "/auth/google/connect": {
      get: { tags: ["google"], summary: "Start Google OAuth (logged-in consultant)", description: "Browser redirect to Google's consent screen. Scopes: `calendar.events.owned` + `calendar.freebusy`.", security: bearer, parameters: [{ name: "resourceId", in: "query", required: true, schema: { type: "string", format: "uuid" } }], responses: { 302: { description: "Redirect to Google" } } },
    },
    "/auth/google/start": {
      get: { tags: ["google"], summary: "Start Google OAuth from a signed link", parameters: [{ name: "token", in: "query", required: true, schema: { type: "string" } }], responses: { 302: { description: "Redirect to Google" }, 401: errorResponse("Link invalid or expired") } },
    },
    "/auth/google/callback": {
      get: { tags: ["google"], summary: "Google OAuth redirect target", parameters: [{ name: "code", in: "query", schema: { type: "string" } }, { name: "state", in: "query", schema: { type: "string" } }], responses: { 200: { description: "Connected" } } },
    },

    "/v1/consultant/payments": {
      get: { tags: ["consultant"], summary: "Payment settings (fees)", security: bearer, responses: { 200: json({ type: "object", properties: { payments: ref("ClinicPayments") } }), 401: errorResponse("Unauthorized") } },
      put: {
        tags: ["consultant"],
        summary: "Set consultation fees and switch payment collection on/off",
        description: "Rates are rupees per hour, prorated by the service duration. `variable`: the start time picks the band — night (overrides) → weekend (Sat/Sun) → weekday, in the clinic's timezone. 403 until the admin has enabled payments for this clinic.",
        security: bearer,
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", properties: { collectPayments: { type: "boolean" }, pricing: ref("Pricing") } },
              examples: {
                flat: { summary: "Same hourly fee always", value: { collectPayments: true, pricing: { mode: "flat", hourlyRate: 1000 } } },
                variable: { summary: "Weekday / weekend / night", value: { collectPayments: true, pricing: { mode: "variable", weekdayRate: 1000, weekendRate: 1500, nightRate: 2000, nightStart: "20:00", nightEnd: "06:00" } } },
              },
            },
          },
        },
        responses: { 200: json({ type: "object", properties: { payments: ref("ClinicPayments") } }), 400: errorResponse("Validation error"), 401: errorResponse("Unauthorized"), 403: errorResponse("Payments not enabled by the admin") },
      },
    },
    "/v1/consultant/payments/quote": {
      get: {
        tags: ["consultant"], summary: "What would a user pay for this service at this time?", security: bearer,
        parameters: [
          { name: "serviceId", in: "query", required: true, schema: { type: "string", format: "uuid" } },
          { name: "startAt", in: "query", required: true, schema: { type: "string", format: "date-time" }, example: "2026-10-10T12:00:00+05:30" },
        ],
        responses: { 200: json({ type: "object", properties: { amount: { type: "string", example: "₹750" }, amountPaise: { type: "integer" }, band: { type: "string", enum: ["flat", "weekday", "weekend", "night"] }, hourlyRate: { type: "number" } } }), 400: errorResponse("No fees set / bad input") },
      },
    },
    "/v1/public/{tenantSlug}/chat/payments/{appointmentId}": {
      get: {
        tags: ["agent"], summary: "Payment outcome for a held booking (the widget polls this)",
        description: "Asks Razorpay directly, so it confirms a paid booking even if the webhook never arrived. `message` is null while payment is still pending.",
        parameters: [tenantParam, idParam("Appointment id (uuid)")].map((p: any, i) => (i === 1 ? { ...p, name: "appointmentId" } : p)),
        responses: { 200: json({ type: "object", properties: { paymentStatus: { type: "string", enum: ["created", "paid", "expired", "failed", "cancelled"] }, appointmentStatus: { type: "string" }, message: { type: "string", nullable: true } } }), 404: errorResponse("No payment for that appointment") },
      },
    },
    "/v1/admin/tenants": {
      get: { tags: ["admin"], summary: "Admin: list consultants and their payment status", security: [{ adminAuth: [] }], responses: { 200: json({ type: "object", properties: { tenants: { type: "array", items: ref("AdminPayments") } } }), 401: errorResponse("Bad platform token") } },
    },
    "/v1/admin/tenants/{slug}/payments": {
      get: { tags: ["admin"], summary: "Admin: a consultant's Razorpay setup", security: [{ adminAuth: [] }], parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }], responses: { 200: json({ type: "object", properties: { payments: ref("AdminPayments") } }), 404: errorResponse("Unknown clinic") } },
      put: {
        tags: ["admin"],
        summary: "Admin: store a consultant's Razorpay credentials and enable/disable payments",
        description: "Credentials are checked against Razorpay before being stored, and encrypted at rest. Omitted fields keep their stored value. The response's `webhookUrl` is what to register in the consultant's Razorpay dashboard (event `payment_link.paid`).",
        security: [{ adminAuth: [] }],
        parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string", example: "demo-clinic" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { enabled: { type: "boolean" }, razorpayKeyId: { type: "string", example: "rzp_test_xxxxxxxx" }, razorpayKeySecret: { type: "string" }, razorpayWebhookSecret: { type: "string" } } } } } },
        responses: { 200: json({ type: "object", properties: { payments: ref("AdminPayments") } }), 400: errorResponse("Missing or rejected credentials"), 401: errorResponse("Bad platform token"), 403: errorResponse("Admin API disabled") },
      },
    },
    "/v1/webhooks/razorpay/{tenantSlug}": {
      post: { tags: ["payments"], summary: "Razorpay webhook (called by Razorpay)", description: "Signed with `X-Razorpay-Signature` using the clinic's webhook secret. `payment_link.paid` confirms the held booking. Idempotent.", parameters: [tenantParam], requestBody: { content: { "application/json": { schema: { type: "object" } } } }, responses: { 200: { description: "Processed or ignored" }, 401: { description: "Bad signature" } } },
    },

    "/v1/webhooks/whatsapp": {
      get: { tags: ["whatsapp"], summary: "Meta webhook verification handshake", parameters: [{ name: "hub.mode", in: "query", schema: { type: "string" } }, { name: "hub.verify_token", in: "query", schema: { type: "string" } }, { name: "hub.challenge", in: "query", schema: { type: "string" } }], responses: { 200: { description: "Echoes hub.challenge" }, 403: { description: "Bad verify token" } } },
      post: { tags: ["whatsapp"], summary: "Inbound WhatsApp messages (called by Meta)", description: "Signed with `X-Hub-Signature-256`. Messages from the clinic's staff number are treated as doctor commands (APPROVE / REJECT / CANCEL / PENDING / CONNECT); everyone else talks to the agent.", requestBody: { content: { "application/json": { schema: { type: "object" } } } }, responses: { 200: { description: "Acknowledged" }, 401: { description: "Bad signature" } } },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      adminAuth: { type: "http", scheme: "bearer", description: "The ADMIN_TOKEN env value (not a consultant token)" },
    },
    schemas: {
      Pricing: {
        oneOf: [
          { type: "object", required: ["mode", "hourlyRate"], properties: { mode: { type: "string", enum: ["flat"] }, hourlyRate: { type: "number", example: 1000 } } },
          { type: "object", required: ["mode", "weekdayRate", "weekendRate", "nightRate"], properties: { mode: { type: "string", enum: ["variable"] }, weekdayRate: { type: "number" }, weekendRate: { type: "number" }, nightRate: { type: "number" }, nightStart: { type: "string", example: "20:00", default: "20:00" }, nightEnd: { type: "string", example: "06:00", default: "06:00" } } },
        ],
      },
      ClinicPayments: {
        type: "object",
        properties: { available: { type: "boolean", description: "The admin has enabled payments for this consultant" }, collectPayments: { type: "boolean" }, currency: { type: "string", example: "INR" }, pricing: ref("Pricing"), note: { type: "string" } },
      },
      AdminPayments: {
        type: "object",
        properties: { slug: { type: "string" }, name: { type: "string" }, paymentsEnabled: { type: "boolean" }, razorpayKeyId: { type: "string", nullable: true }, razorpayMode: { type: "string", enum: ["test", "live"], nullable: true }, keySecretConfigured: { type: "boolean" }, webhookSecretConfigured: { type: "boolean" }, consultantCollectsPayments: { type: "boolean" }, consultationPricing: ref("Pricing"), webhookUrl: { type: "string" } },
      },
      Error: { type: "object", properties: { error: { type: "string" }, correlationId: { type: "string" } } },
      ChatRequest: {
        type: "object", required: ["sessionId", "message"],
        properties: {
          sessionId: { type: "string", maxLength: 100, description: "Any stable id for this visitor; reuse it to continue the conversation." },
          message: { type: "string" },
          phone: { type: "string", description: "Optional. Captured at once as an unverified contact; the visitor must still verify it by code before it unlocks anything." },
          name: { type: "string", description: "Optional, saved with `phone`." },
        },
      },
      ChatResponse: {
        type: "object",
        properties: {
          replyText: { type: "string" },
          mode: { type: "string", enum: ["agent", "guided"], description: "`guided` = no GEMINI_API_KEY, numbered-menu fallback." },
          options: { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" } } }, description: "Menu buttons (guided mode only)." },
          payment: {
            type: "object",
            description: "Present when the patient still has to pay to confirm a held booking. The web widget renders it as a Pay button; on WhatsApp the same link is already in replyText.",
            properties: { appointmentId: { type: "string", format: "uuid" }, url: { type: "string" }, amount: { type: "string", example: "₹500" }, amountPaise: { type: "integer" }, expiresAt: { type: "string", format: "date-time" } },
          },
          trace: { type: "array", items: ref("AgentEvent"), description: "Present with trace=true." },
        },
      },
      AgentEvent: {
        type: "object",
        description: "One thing the agent did during the turn.",
        required: ["type"],
        properties: {
          type: { type: "string", enum: ["tool_call", "tool_result", "model_text", "text_delta", "error"] },
          step: { type: "integer", description: "Model round-trip index within the turn." },
          name: { type: "string", description: "Tool name (tool_call / tool_result)." },
          args: { type: "object", description: "Arguments the model passed (tool_call)." },
          result: { type: "object", description: "What the tool returned to the model (tool_result)." },
          durationMs: { type: "integer" },
          text: { type: "string" },
          message: { type: "string" },
        },
      },
      AgentInfo: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["agent", "guided"] }, note: { type: "string" }, model: { type: "string", nullable: true },
          bookingFlow: { type: "string", enum: ["instant", "staff_approval"] }, systemPrompt: { type: "string" }, tools: { type: "array", items: { type: "object" } },
        },
      },
      LoginRequest: { type: "object", required: ["email", "password"], properties: { email: { type: "string", format: "email" }, password: { type: "string" } } },
      Settings: {
        type: "object",
        properties: {
          name: { type: "string" }, timezone: { type: "string" },
          confirmationPolicy: { type: "string", enum: ["instant", "staff_approval"], description: "instant = direct booking; staff_approval = doctor must accept." },
          staffWhatsappNumber: { type: "string", nullable: true, description: "Digits with country code. Gets approval requests and may send APPROVE/REJECT commands." },
          reminderHoursBefore: { type: "integer", description: "0 disables reminders." },
          faqText: { type: "string", nullable: true, description: "Clinic info the agent may answer questions from." },
          whatsappPhoneNumberId: { type: "string", nullable: true },
        },
      },
      SettingsPatch: {
        type: "object", description: "Any subset of the settings.",
        properties: {
          confirmationPolicy: { type: "string", enum: ["instant", "staff_approval"] },
          staffWhatsappNumber: { type: "string", nullable: true, example: "+91 98765 43210" },
          reminderHoursBefore: { type: "integer", minimum: 0, maximum: 168 },
          faqText: { type: "string", nullable: true, maxLength: 4000 },
          whatsappPhoneNumberId: { type: "string", nullable: true },
        },
      },
      User: {
        type: "object",
        description: "Created automatically from the first message; identity is the phone number (unique per clinic).",
        properties: {
          id: { type: "string", format: "uuid" },
          name: { type: "string", nullable: true },
          nameSource: { type: "string", enum: ["whatsapp_profile", "patient"], nullable: true, description: "`whatsapp_profile` = taken from the WhatsApp profile, replaced once the patient states their name." },
          phone: { type: "string" }, phoneNormalized: { type: "string", description: "Digits with country code — the identity key." },
          phoneVerified: { type: "boolean", description: "True for WhatsApp senders and after a successful web OTP." },
          email: { type: "string", nullable: true }, dateOfBirth: { type: "string", format: "date", nullable: true }, preferredLanguage: { type: "string", nullable: true },
          firstChannel: { type: "string", enum: ["web", "whatsapp"] }, firstSeenAt: { type: "string", format: "date-time" }, lastSeenAt: { type: "string", format: "date-time" },
        },
      },
      Appointment: {
        type: "object",
        properties: {
          id: { type: "string", format: "uuid" }, status: { type: "string", enum: ["AWAITING_PAYMENT", "PENDING_CONFIRMATION", "CONFIRMED", "REJECTED", "CANCELLED", "COMPLETED"] },
          start_at: { type: "string", format: "date-time" }, end_at: { type: "string", format: "date-time" }, channel: { type: "string", enum: ["web", "whatsapp"] },
          patient_name: { type: "string" }, patient_phone: { type: "string" }, service_name: { type: "string" }, resource_name: { type: "string" },
          payment_status: { type: "string", enum: ["created", "paid", "expired", "failed", "cancelled"], nullable: true }, amount_paise: { type: "integer", nullable: true },
          calendar_sync_status: { type: "string", enum: ["pending", "synced", "failed", "skipped"] }, google_event_id: { type: "string", nullable: true },
        },
      },
    },
  },
};

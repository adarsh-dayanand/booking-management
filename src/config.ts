import "dotenv/config";

// Deliberately no eager `required()` throws here for DATABASE_URL / JWT_SECRET /
// CRYPTO_KEY: this module is imported transitively by almost everything
// (including pure logic like slot generation), so importing it must never
// throw just because an env var isn't set yet. Each of those values is
// validated lazily, right where it's actually used (db.ts connecting,
// auth.ts signing/verifying a token, crypto.ts encrypting/decrypting) — so a
// missing var only breaks the specific feature that needs it, not the whole
// process or the unit test suite.

function optional(name: string): string | undefined {
  return process.env[name] || undefined;
}

export const config = {
  port: Number(process.env.PORT || 4000),
  baseUrl: process.env.BASE_URL || "http://localhost:4000",
  databaseUrl: optional("DATABASE_URL"),
  jwtSecret: optional("JWT_SECRET"),
  cryptoKey: optional("CRYPTO_KEY"),
  google: {
    clientId: optional("GOOGLE_CLIENT_ID"),
    clientSecret: optional("GOOGLE_CLIENT_SECRET"),
    redirectUri: optional("GOOGLE_REDIRECT_URI"),
  },
  whatsapp: {
    accessToken: optional("WHATSAPP_ACCESS_TOKEN"),
    verifyToken: optional("WHATSAPP_VERIFY_TOKEN"),
    appSecret: optional("WHATSAPP_APP_SECRET"),
    // Approved Meta template with a single body variable ({{1}}); used only when a free-text send
    // fails (e.g. outside the 24h customer-service window) so reminders/approvals still get through.
    notifyTemplate: optional("WHATSAPP_NOTIFY_TEMPLATE"),
    notifyTemplateLang: process.env.WHATSAPP_NOTIFY_TEMPLATE_LANG || "en",
  },
  // Prepended to 10-digit numbers typed without a country code (India by default).
  defaultCountryCode: process.env.DEFAULT_COUNTRY_CODE || "91",
  isProduction: process.env.NODE_ENV === "production",
  // Lets API callers see the agent's tool calls/results and system prompt (Swagger "Try it out"). Off in production unless AGENT_TRACE=1.
  agentTraceEnabled: process.env.AGENT_TRACE ? process.env.AGENT_TRACE === "1" : process.env.NODE_ENV !== "production",
  // Swagger UI at /docs. Off in production unless ENABLE_DOCS=1.
  docsEnabled: process.env.ENABLE_DOCS ? process.env.ENABLE_DOCS === "1" : process.env.NODE_ENV !== "production",
  schedulerEnabled: process.env.DISABLE_SCHEDULER !== "1" && process.env.NODE_ENV !== "test",
  schedulerIntervalMs: Number(process.env.SCHEDULER_INTERVAL_MS || 5 * 60_000),
  // Admin's (platform operator's) secret for /v1/admin/* (enable payments + store Razorpay keys per consultant). Unset = that API is off.
  adminToken: optional("ADMIN_TOKEN"),
  payments: {
    apiBase: process.env.RAZORPAY_API_BASE || "https://api.razorpay.com/v1",
    // How long an unpaid slot is held. Razorpay requires payment links to live at least 15 minutes.
    holdMinutes: Math.max(16, Number(process.env.PAYMENT_HOLD_MINUTES || 20)),
  },
  gemini: {
    apiKey: optional("GEMINI_API_KEY"),
    model: optional("GEMINI_MODEL"),
    // Override for proxies or tests; defaults to Google's public endpoint.
    baseUrl: process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/models",
  },
};

export const isGoogleConfigured = Boolean(
  config.google.clientId && config.google.clientSecret && config.google.redirectUri
);

export const isWhatsappConfigured = Boolean(config.whatsapp.accessToken && config.whatsapp.verifyToken);


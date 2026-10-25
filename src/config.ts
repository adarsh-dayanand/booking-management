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

const LLM_PROVIDERS = ["gemini", "openai", "anthropic"] as const;
const LLM_DEFAULT_BASE_URLS = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/models",
  // Any OpenAI-compatible API (OpenRouter, Groq, Together, Azure, Ollama, ...) works by changing LLM_BASE_URL.
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};

function llmSettings() {
  const legacy = (provider: string, field: string) => optional(`${provider.toUpperCase()}_${field}`);
  const provider = optional("LLM_PROVIDER")?.toLowerCase() ?? LLM_PROVIDERS.find((p) => legacy(p, "API_KEY"));
  const known = LLM_PROVIDERS.find((p) => p === provider);
  return {
    /** As written in .env (may be invalid); `known` is set only when it is a supported provider. */
    provider,
    known,
    apiKey: optional("LLM_API_KEY") ?? (known && legacy(known, "API_KEY")),
    model: optional("LLM_MODEL") ?? (known && legacy(known, "MODEL")),
    baseUrl: (optional("LLM_BASE_URL") ?? (known && legacy(known, "BASE_URL")) ?? (known && LLM_DEFAULT_BASE_URLS[known]) ?? "").replace(/\/+$/, ""),
  };
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
    // Meta retires old Graph API versions after about two years; match the version shown in your Meta app's API Setup page.
    graphVersion: process.env.WHATSAPP_GRAPH_VERSION || "v25.0",
    // Embedded Signup (consultants connect their own number): the Meta app id and the signup configuration id.
    appId: optional("META_APP_ID"),
    embeddedSignupConfigId: optional("META_EMBEDDED_SIGNUP_CONFIG_ID"),
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
  // The LLM that runs the booking agent. LLM_PROVIDER = gemini | openai | anthropic, with one shared set of settings.
  // The older per-provider variables (GEMINI_API_KEY, OPENAI_MODEL, ANTHROPIC_BASE_URL, ...) still work as a fallback.
  llm: llmSettings(),
  // Email alerts to the clinic's dashboard logins when a patient books or asks for an appointment, sent with Resend. Off until both are set.
  email: {
    resendApiKey: optional("RESEND_API_KEY"),
    from: optional("EMAIL_FROM"),
    // Optional: point Resend calls at a proxy or test double.
    apiBase: (process.env.RESEND_API_BASE || "https://api.resend.com").replace(/\/+$/, ""),
  },
};

export const isGoogleConfigured = Boolean(
  config.google.clientId && config.google.clientSecret && config.google.redirectUri
);

/** Consultants can connect their own number only when the platform has a Meta app (id + secret) and a signup configuration. */
export const isEmbeddedSignupConfigured = Boolean(config.whatsapp.appId && config.whatsapp.appSecret && config.whatsapp.embeddedSignupConfigId);

export const isWhatsappConfigured = Boolean(config.whatsapp.accessToken && config.whatsapp.verifyToken);


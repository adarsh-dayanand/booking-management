// Real database + the real consultant API over HTTP; Meta's Graph API is replaced by a fake at the fetch boundary.
// Covers a consultant connecting their own WhatsApp number (Embedded Signup): what is stored, what is verified,
// and that messages go out with that consultant's token rather than the platform's.

import "dotenv/config";
import { randomUUID } from "crypto";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
process.env.JWT_SECRET ||= "test-jwt-secret";
process.env.CRYPTO_KEY ||= Buffer.alloc(32, 9).toString("base64");
process.env.ADMIN_TOKEN = "test-admin-token-1234567890";
process.env.META_APP_ID = "1111222233334444";
process.env.WHATSAPP_APP_SECRET = "app-secret-for-tests-0000000000";
process.env.META_EMBEDDED_SIGNUP_CONFIG_ID = "9998887776665554";
process.env.WHATSAPP_ACCESS_TOKEN = "PLATFORM-TOKEN";
process.env.WHATSAPP_NOTIFY_TEMPLATE = "platform_template";
vi.mock("../lib/rateLimit", () => ({ rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(), allow: () => true }));

let pool: Pool;
let server: Server;
let base: string;
let whatsapp: typeof import("../channels/whatsapp");
const slugs: string[] = [];
const realFetch = globalThis.fetch;

// --- fake Meta ---------------------------------------------------------------
interface Sent { path: string; method: string; auth: string; body: any }
const sent: Sent[] = [];
let wabaPhones: { id: string; display_phone_number: string; verified_name: string }[] = [];
let failRegister = false;
let failTextSend = false;
let templateExists = false;
let codeValid = true;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeMeta(url: string, init: RequestInit = {}): Response | null {
  if (!url.startsWith("https://graph.facebook.com/")) return null;
  const u = new URL(url);
  const path = u.pathname.replace(/^\/v[\d.]+/, "");
  const method = init.method ?? "GET";
  const auth = String((init.headers as Record<string, string> | undefined)?.Authorization ?? "");
  const body = init.body ? JSON.parse(String(init.body)) : undefined;
  sent.push({ path: path + (u.search || ""), method, auth, body });

  // every valid code yields its own token, so tests can tell two consultants' tokens apart
  if (path === "/oauth/access_token") return codeValid && (u.searchParams.get("code") ?? "").startsWith("GOOD-CODE") ? json({ access_token: "TENANT-TOKEN-" + u.searchParams.get("code") }) : json({ error: { message: "Invalid verification code format." } }, 400);
  let m = path.match(/^\/(\d+)\/phone_numbers$/);
  if (m) return json({ data: wabaPhones });
  m = path.match(/^\/(\d+)\/register$/);
  if (m) return failRegister ? json({ error: { message: "Phone number is not eligible: add a payment method" } }, 400) : json({ success: true });
  m = path.match(/^\/(\d+)\/subscribed_apps$/);
  if (m) return json({ success: true });
  m = path.match(/^\/(\d+)\/message_templates$/);
  if (m && method === "POST") return templateExists ? json({ error: { message: "Template name already exists", code: 2388023 } }, 400) : json({ id: "tpl1", status: "PENDING" });
  if (m && method === "GET") return json({ data: [{ status: "APPROVED" }] });
  m = path.match(/^\/(\d+)\/messages$/);
  if (m) return body?.type === "text" && failTextSend ? json({ error: { message: "Re-engagement message" } }, 400) : json({ messages: [{ id: "wamid.x" }] });
  m = path.match(/^\/(\d+)$/);
  if (m) {
    const phone = wabaPhones.find((p) => p.id === m![1]);
    return phone ? json({ display_phone_number: phone.display_phone_number, verified_name: phone.verified_name, quality_rating: "GREEN" }) : json({ error: { message: "Unsupported get request" } }, 400);
  }
  return json({ error: { message: `unexpected ${method} ${path}` } }, 404);
}

async function call(method: string, path: string, opts: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await realFetch(`${base}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const uniq = () => Math.floor(Math.random() * 9e9 + 1e9).toString();
async function onboard() {
  const id = randomUUID().slice(0, 8);
  const slug = `wa-${id}`;
  slugs.push(slug);
  const email = `o-${id}@example.test`;
  const created = await call("POST", "/v1/admin/tenants", { token: process.env.ADMIN_TOKEN, body: { name: `WA Clinic ${id}`, slug, timezone: "Asia/Kolkata", owner: { email, password: "password-123" } } });
  expect(created.status).toBe(201);
  const token = (await call("POST", "/v1/consultant/login", { body: { email, password: "password-123" } })).body.token as string;
  return { slug, token };
}
const phone = (id = uniq()) => ({ id, display_phone_number: "+91 98765 43210", verified_name: "Sunrise Dental" });
const connect = (token: string, p = wabaPhones[0], over: Record<string, unknown> = {}) =>
  call("POST", "/v1/consultant/whatsapp/connect", { token, body: { code: "GOOD-CODE", phoneNumberId: p.id, wabaId: "5550001112223", ...over } });
const row = async (slug: string) => (await pool.query("SELECT * FROM tenants WHERE slug = $1", [slug])).rows[0];
const messageCalls = () => sent.filter((s) => s.path.endsWith("/messages"));

beforeAll(async () => {
  const { default: express } = await import("express");
  const { AppError } = await import("../errors");
  const { adminRouter } = await import("../http/routes/admin");
  const { consultantRouter } = await import("../http/routes/consultant");
  ({ pool } = await import("../lib/db"));
  whatsapp = await import("../channels/whatsapp");
  const app = express();
  app.use(express.json());
  app.use("/v1/admin", adminRouter);
  app.use("/v1/consultant", consultantRouter);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: unknown, res: any, _next: unknown) => {
    if (err instanceof AppError) return res.status(err.statusCode).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });
  await new Promise<void>((resolve) => (server = app.listen(0, resolve)));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => fakeMeta(String(url), init) ?? realFetch(url, init)));
});

beforeEach(() => {
  sent.length = 0;
  wabaPhones = [phone()];
  failRegister = failTextSend = templateExists = false;
  codeValid = true;
  whatsapp.clearCredentialCache();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  const t = (await pool.query("SELECT id FROM tenants WHERE slug = ANY($1)", [slugs])).rows.map((r) => r.id);
  for (const table of ["appointments", "patients", "availability_rules", "services", "resources", "staff_users"]) await pool.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1)`, [t]);
  await pool.query("DELETE FROM tenants WHERE id = ANY($1)", [t]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

describe("before connecting", () => {
  it("tells the dashboard whether signup is available, exposing only public ids", async () => {
    const { token } = await onboard();
    const r = await call("GET", "/v1/consultant/whatsapp", { token });
    expect(r.body.signup).toEqual({ available: true, appId: "1111222233334444", configId: "9998887776665554", graphVersion: expect.stringMatching(/^v\d+/) });
    expect(JSON.stringify(r.body)).not.toContain("app-secret-for-tests");
    expect(r.body.connection).toMatchObject({ mode: "none", phoneNumberId: null });
  });

  it("requires a login", async () => {
    expect((await call("GET", "/v1/consultant/whatsapp")).status).toBe(401);
    expect((await call("POST", "/v1/consultant/whatsapp/connect", { body: {} })).status).toBe(401);
  });
});

describe("connecting a consultant's own number", () => {
  it("exchanges the code server-side, verifies the number, registers it, subscribes the webhook and creates the template", async () => {
    const { token, slug } = await onboard();
    const r = await connect(token);
    expect(r.status).toBe(201);
    expect(r.body.warnings).toEqual([]);
    expect(r.body.connection).toMatchObject({ mode: "own", phoneNumberId: wabaPhones[0].id, displayPhone: "+91 98765 43210", verifiedName: "Sunrise Dental", quality: "GREEN", template: { name: "booking_update", status: "APPROVED" } });

    // the code was exchanged using the app secret, which stays on the server
    const exchange = sent.find((s) => s.path.startsWith("/oauth/access_token"))!;
    expect(exchange.path).toContain("client_secret=app-secret-for-tests-0000000000");
    expect(exchange.path).toContain("code=GOOD-CODE");

    // the number was registered with a 6-digit PIN, the app subscribed, and the generic template created in THEIR account
    const register = sent.find((s) => s.path.endsWith("/register"))!;
    expect(register.auth).toBe("Bearer TENANT-TOKEN-GOOD-CODE");
    expect(register.body.pin).toMatch(/^\d{6}$/);
    expect(sent.some((s) => s.path === "/5550001112223/subscribed_apps" && s.method === "POST")).toBe(true);
    const tpl = sent.find((s) => s.path.endsWith("/message_templates") && s.method === "POST")!;
    expect(tpl.body).toMatchObject({ name: "booking_update", category: "UTILITY" });
    const text = tpl.body.components[0].text as string;
    expect(text).toContain("{{1}}");
    expect(text.startsWith("{{")).toBe(false); // Meta rejects a variable at the very start or end
    expect(text.trimEnd().endsWith("}}")).toBe(false);

    const t = await row(slug);
    expect(t).toMatchObject({ whatsapp_phone_number_id: wabaPhones[0].id, whatsapp_waba_id: "5550001112223", whatsapp_template_name: "booking_update" });
    expect(t.whatsapp_connected_at).toBeTruthy();
  });

  it("stores the token and PIN encrypted, and never returns them", async () => {
    const { token, slug } = await onboard();
    const r = await connect(token);
    const t = await row(slug);
    expect(t.whatsapp_access_token_encrypted).not.toContain("TENANT-TOKEN");
    const { decrypt } = await import("../lib/crypto");
    expect(decrypt(t.whatsapp_access_token_encrypted)).toBe("TENANT-TOKEN-GOOD-CODE");
    expect(decrypt(t.whatsapp_register_pin_encrypted)).toBe(sent.find((s) => s.path.endsWith("/register"))!.body.pin);
    expect(JSON.stringify(r.body)).not.toMatch(/TENANT-TOKEN|access_token|pin/i);
    expect(JSON.stringify((await call("GET", "/v1/consultant/whatsapp", { token })).body)).not.toContain("TENANT-TOKEN");
    expect(JSON.stringify((await call("GET", "/v1/consultant/settings", { token })).body)).not.toContain("TENANT-TOKEN");
  });

  it("rejects a number that isn't in the WhatsApp account the token can see (the browser's claim isn't trusted)", async () => {
    const { token, slug } = await onboard();
    const r = await connect(token, { id: "777000111222", display_phone_number: "x", verified_name: "x" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("doesn't belong");
    expect((await row(slug)).whatsapp_access_token_encrypted).toBeNull();
  });

  it("surfaces Meta's rejection of an expired or reused code", async () => {
    const { token } = await onboard();
    const r = await connect(token, undefined, { code: "STALE-CODE" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("Invalid verification code");
  });

  it("rejects malformed ids before calling Meta", async () => {
    const { token } = await onboard();
    expect((await connect(token, undefined, { phoneNumberId: "abc" })).status).toBe(400);
    expect((await connect(token, undefined, { wabaId: "../../x" })).status).toBe(400);
    expect((await call("POST", "/v1/consultant/whatsapp/connect", { token, body: { code: "x" } })).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("won't connect a number that another consultant already uses", async () => {
    const a = await onboard();
    const b = await onboard();
    expect((await connect(a.token)).status).toBe(201);
    const r = await connect(b.token);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("already connected to another consultant");
  });

  it("keeps the connection but warns when a follow-up step fails, and repair fixes it", async () => {
    const { token } = await onboard();
    failRegister = true;
    const r = await connect(token);
    expect(r.status).toBe(201); // the token is saved, so the consultant doesn't have to log in to Facebook again
    expect(r.body.connection.mode).toBe("own");
    expect(r.body.warnings[0]).toContain("Couldn't register the number");
    expect(r.body.warnings[0]).toContain("payment method");

    failRegister = false;
    const fixed = await call("POST", "/v1/consultant/whatsapp/repair", { token });
    expect(fixed.status).toBe(200);
    expect(fixed.body.warnings).toEqual([]);
  });

  it("treats an already-existing template as fine", async () => {
    const { token } = await onboard();
    templateExists = true;
    const r = await connect(token);
    expect(r.body.warnings).toEqual([]);
    expect(r.body.connection.template.name).toBe("booking_update");
  });

  it("repair needs a connection", async () => {
    const { token } = await onboard();
    expect((await call("POST", "/v1/consultant/whatsapp/repair", { token })).status).toBe(404);
  });
});

describe("sending uses the right token", () => {
  it("a connected consultant's messages go out with THEIR token", async () => {
    const { token } = await onboard();
    await connect(token);
    sent.length = 0;
    expect(await whatsapp.deliver(wabaPhones[0].id, "919000011111", "Hello")).toBe("sent");
    expect(messageCalls()).toHaveLength(1);
    expect(messageCalls()[0].auth).toBe("Bearer TENANT-TOKEN-GOOD-CODE");
  });

  it("outside the 24-hour window it falls back to THEIR template, not the platform's", async () => {
    const { token } = await onboard();
    await connect(token);
    sent.length = 0;
    failTextSend = true;
    expect(await whatsapp.deliver(wabaPhones[0].id, "919000011111", "Reminder: tomorrow 10am")).toBe("sent");
    const calls = messageCalls();
    expect(calls.map((c) => c.body.type)).toEqual(["text", "template"]);
    expect(calls[1].body.template.name).toBe("booking_update");
    expect(calls[1].auth).toBe("Bearer TENANT-TOKEN-GOOD-CODE");
  });

  it("a number the platform operator added (no consultant token) still uses the platform-wide token and template", async () => {
    const { slug } = await onboard();
    const platformPhone = uniq();
    await pool.query("UPDATE tenants SET whatsapp_phone_number_id = $2 WHERE slug = $1", [slug, platformPhone]);
    whatsapp.clearCredentialCache();
    failTextSend = true;
    expect(await whatsapp.deliver(platformPhone, "919000011111", "Hi")).toBe("sent");
    const calls = messageCalls();
    expect(calls[0].auth).toBe("Bearer PLATFORM-TOKEN");
    expect(calls[1].body.template.name).toBe("platform_template");
  });

  it("two consultants never share a token", async () => {
    const a = await onboard();
    const b = await onboard();
    const pa = phone();
    const pb = phone();
    wabaPhones = [pa, pb];
    await connect(a.token, pa, { code: "GOOD-CODE-A" });
    await connect(b.token, pb, { code: "GOOD-CODE-B", wabaId: "5550009998887" });
    sent.length = 0;
    await whatsapp.deliver(pa.id, "919000011111", "to a");
    await whatsapp.deliver(pb.id, "919000011111", "to b");
    expect(messageCalls().map((c) => [c.path, c.auth])).toEqual([
      [`/${pa.id}/messages`, "Bearer TENANT-TOKEN-GOOD-CODE-A"],
      [`/${pb.id}/messages`, "Bearer TENANT-TOKEN-GOOD-CODE-B"],
    ]);
  });

  it("an unknown number falls back to the platform token; no number at all is skipped", async () => {
    expect(await whatsapp.deliver("123456789012345", "919000011111", "x")).toBe("sent");
    expect(messageCalls().at(-1)!.auth).toBe("Bearer PLATFORM-TOKEN");
    expect(await whatsapp.deliver(null, "919000011111", "x")).toBe("skipped");
  });
});

describe("disconnecting and the settings guard", () => {
  it("forgets the token, unsubscribes, and stops sending on that number", async () => {
    const { token, slug } = await onboard();
    await connect(token);
    const phoneId = wabaPhones[0].id;
    sent.length = 0;
    expect((await call("DELETE", "/v1/consultant/whatsapp", { token })).status).toBe(204);
    expect(sent.some((s) => s.path === "/5550001112223/subscribed_apps" && s.method === "DELETE")).toBe(true);
    const t = await row(slug);
    expect(t).toMatchObject({ whatsapp_phone_number_id: null, whatsapp_waba_id: null, whatsapp_access_token_encrypted: null, whatsapp_template_name: null });
    expect((await call("GET", "/v1/consultant/whatsapp", { token })).body.connection.mode).toBe("none");
    sent.length = 0;
    await whatsapp.deliver(phoneId, "919000011111", "x");
    expect(messageCalls().every((c) => !c.auth.includes("TENANT-TOKEN"))).toBe(true); // the old token is gone
  });

  it("disconnecting works even if Meta is unreachable", async () => {
    const { token, slug } = await onboard();
    await connect(token);
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => (String(url).startsWith("https://graph.facebook.com/") ? Promise.reject(new Error("offline")) : realFetch(url, init))));
    try {
      expect((await call("DELETE", "/v1/consultant/whatsapp", { token })).status).toBe(204);
    } finally {
      vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => fakeMeta(String(url), init) ?? realFetch(url, init)));
    }
    expect((await row(slug)).whatsapp_access_token_encrypted).toBeNull();
  });

  it("a consultant can no longer type a WhatsApp phone number id into Settings", async () => {
    const { token } = await onboard();
    const r = await call("PUT", "/v1/consultant/settings", { token, body: { whatsappPhoneNumberId: "1440736872449106" } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/unrecognized/i);
    expect((await call("PUT", "/v1/consultant/settings", { token, body: { reminderHoursBefore: 12 } })).status).toBe(200);
  });

  it("the admin can't swap the number out from under a consultant's connection", async () => {
    const { token, slug } = await onboard();
    await connect(token);
    const admin = (body: object) => call("PUT", `/v1/admin/tenants/${slug}`, { token: process.env.ADMIN_TOKEN, body });
    const r = await admin({ whatsappPhoneNumberId: "999888777666" });
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("connected their own WhatsApp number");
    expect((await admin({ whatsappPhoneNumberId: null })).status).toBe(400);
    expect((await admin({ name: "Renamed" })).status).toBe(200); // other edits are fine
    expect((await admin({ whatsappPhoneNumberId: wabaPhones[0].id })).status).toBe(200); // re-sending the same value is a no-op
  });

  it("the admin sees who has connected their own number", async () => {
    const { token, slug } = await onboard();
    await connect(token);
    const r = await call("GET", `/v1/admin/tenants/${slug}`, { token: process.env.ADMIN_TOKEN });
    expect(r.body.consultant.whatsapp).toMatchObject({ mode: "own", displayPhone: "+91 98765 43210", verifiedName: "Sunrise Dental" });
    expect(JSON.stringify(r.body)).not.toContain("TENANT-TOKEN");
  });
});

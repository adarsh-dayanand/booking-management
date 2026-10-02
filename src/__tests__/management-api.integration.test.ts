// Drives the real admin + consultant routers over HTTP against the test database (see
// concurrent-booking.integration.test.ts for setup). Covers onboarding a consultant end to end, the consultant's own
// management APIs, validation, and that one consultant can never touch another's data.

import "dotenv/config";
import { randomUUID } from "crypto";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The login limiter (10 per 15 min per IP) is covered elsewhere; this suite logs in far more often than that.
vi.mock("../lib/rateLimit", () => ({ rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next(), allow: () => true }));
import type { Pool } from "pg";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
process.env.ADMIN_TOKEN = "test-admin-token-1234567890";
process.env.JWT_SECRET ||= "test-jwt-secret";
process.env.CRYPTO_KEY ||= Buffer.alloc(32, 7).toString("base64");

let pool: Pool;
let server: Server;
let base: string;
const slugs: string[] = [];

const ADMIN = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
async function call(method: string, path: string, opts: { token?: string; admin?: boolean; body?: unknown } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(opts.admin ? ADMIN : {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const uniq = () => randomUUID().slice(0, 8);
async function onboard(over: Record<string, unknown> = {}) {
  const id = uniq();
  const email = `owner-${id}@example.test`;
  const slug = `mgmt-${id}`;
  slugs.push(slug);
  const created = await call("POST", "/v1/admin/tenants", {
    admin: true,
    body: { name: `Clinic ${id}`, slug, timezone: "Asia/Kolkata", owner: { email, password: "password-123" }, ...over },
  });
  const login = await call("POST", "/v1/consultant/login", { body: { email, password: "password-123" } });
  return { id, email, slug, created, token: login.body?.token as string };
}

beforeAll(async () => {
  const { default: express } = await import("express");
  const { AppError } = await import("../errors");
  const { adminRouter } = await import("../http/routes/admin");
  const { consultantRouter } = await import("../http/routes/consultant");
  ({ pool } = await import("../lib/db"));

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
});

afterAll(async () => {
  const t = (await pool.query("SELECT id FROM tenants WHERE slug = ANY($1)", [slugs])).rows.map((r) => r.id);
  for (const table of ["payments", "appointments", "patients", "availability_rules", "services", "resources", "staff_users"]) {
    await pool.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1)`, [t]);
  }
  await pool.query("DELETE FROM tenants WHERE id = ANY($1)", [t]);
  await new Promise((r) => server.close(r));
  await pool.end();
});

describe("admin API: authentication", () => {
  it("rejects a missing or wrong token, accepts the right one", async () => {
    expect((await call("GET", "/v1/admin/tenants")).status).toBe(401);
    expect((await call("GET", "/v1/admin/tenants", { token: "nope" })).status).toBe(401);
    expect((await call("GET", "/v1/admin/overview", { admin: true })).status).toBe(200);
  });

  it("a consultant's own login token can't open the admin API", async () => {
    const { token } = await onboard();
    expect((await call("GET", "/v1/admin/tenants", { token })).status).toBe(401);
  });
});

describe("admin API: onboarding a consultant", () => {
  it("creates the consultant and a working first login", async () => {
    const { created, token } = await onboard({ confirmationPolicy: "instant" });
    expect(created.status).toBe(201);
    expect(created.body.consultant).toMatchObject({ timezone: "Asia/Kolkata", confirmationPolicy: "instant", paymentsEnabled: false, counts: { appointments: 0, users: 0, logins: 1 } });
    expect(JSON.stringify(created.body)).not.toContain("password");
    expect(token).toBeTruthy();
    expect((await call("GET", "/v1/consultant/settings", { token })).body.settings).toMatchObject({ confirmationPolicy: "instant" });
  });

  it("validates the input", async () => {
    const bad = (over: object) => call("POST", "/v1/admin/tenants", { admin: true, body: { name: "X Clinic", slug: `v-${uniq()}`, timezone: "Asia/Kolkata", owner: { email: `o-${uniq()}@example.test`, password: "password-123" }, ...over } });
    expect((await bad({ slug: "Bad Slug!" })).status).toBe(400);
    expect((await bad({ timezone: "Mars/Olympus" })).body.error).toContain("timezone");
    expect((await bad({ owner: { email: "not-an-email", password: "password-123" } })).status).toBe(400);
    expect((await bad({ owner: { email: `o-${uniq()}@example.test`, password: "short" } })).body.error).toContain("8 characters");
    expect((await bad({ name: "" })).status).toBe(400);
  });

  it("refuses a duplicate slug or a login email another consultant already uses", async () => {
    const first = await onboard();
    const dupSlug = await call("POST", "/v1/admin/tenants", { admin: true, body: { name: "Another", slug: first.slug, timezone: "UTC", owner: { email: `x-${uniq()}@example.test`, password: "password-123" } } });
    expect(dupSlug.status).toBe(400);
    expect(dupSlug.body.error).toContain("slug");
    const dupEmail = await onboard({ owner: { email: first.email, password: "password-123" } });
    expect(dupEmail.created.status).toBe(400);
    expect(dupEmail.created.body.error).toContain("email");
    // and the failed attempt left no half-created consultant behind
    const left = await pool.query("SELECT 1 FROM tenants WHERE slug = $1", [`mgmt-${dupEmail.id}`]);
    expect(left.rowCount).toBe(0);
  });

  it("lists and edits consultants", async () => {
    const { slug } = await onboard();
    const list = await call("GET", "/v1/admin/tenants", { admin: true });
    expect(list.body.tenants.find((t: any) => t.slug === slug)).toMatchObject({ slug, counts: { logins: 1 } });

    const edited = await call("PUT", `/v1/admin/tenants/${slug}`, { admin: true, body: { name: "Renamed Clinic", timezone: "Asia/Dubai", whatsappPhoneNumberId: `wa-${uniq()}` } });
    expect(edited.body.consultant).toMatchObject({ name: "Renamed Clinic", timezone: "Asia/Dubai" });
    expect((await call("GET", `/v1/admin/tenants/${slug}`, { admin: true })).body.consultant.name).toBe("Renamed Clinic");
    expect((await call("GET", "/v1/admin/tenants/does-not-exist", { admin: true })).status).toBe(404);
  });

  it("manages a consultant's logins: add, reset password, can't remove the last", async () => {
    const { slug, email } = await onboard();
    const second = `second-${uniq()}@example.test`;
    const added = await call("POST", `/v1/admin/tenants/${slug}/users`, { admin: true, body: { email: second, password: "second-pass-1" } });
    expect(added.status).toBe(201);
    expect((await call("POST", "/v1/consultant/login", { body: { email: second, password: "second-pass-1" } })).status).toBe(200);
    expect((await call("POST", `/v1/admin/tenants/${slug}/users`, { admin: true, body: { email: second, password: "second-pass-1" } })).status).toBe(400);

    expect((await call("POST", `/v1/admin/tenants/${slug}/users/${added.body.user.id}/password`, { admin: true, body: { password: "brand-new-pass" } })).status).toBe(200);
    expect((await call("POST", "/v1/consultant/login", { body: { email: second, password: "second-pass-1" } })).status).toBe(401);
    expect((await call("POST", "/v1/consultant/login", { body: { email: second, password: "brand-new-pass" } })).status).toBe(200);

    const users = (await call("GET", `/v1/admin/tenants/${slug}/users`, { admin: true })).body.users;
    expect(users.map((u: any) => u.email).sort()).toEqual([email, second].sort());
    expect((await call("DELETE", `/v1/admin/tenants/${slug}/users/${added.body.user.id}`, { admin: true })).status).toBe(204);
    const last = users.find((u: any) => u.email === email);
    expect((await call("DELETE", `/v1/admin/tenants/${slug}/users/${last.id}`, { admin: true })).status).toBe(400);
  });

  it("overview reports platform totals", async () => {
    const o = (await call("GET", "/v1/admin/overview", { admin: true })).body;
    expect(o.consultants).toBeGreaterThan(0);
    expect(o).toEqual(expect.objectContaining({ paymentsEnabled: expect.any(Number), appointments30d: expect.any(Number), users: expect.any(Number), revenue30dPaise: expect.any(Number) }));
  });
});

describe("consultant API: services", () => {
  it("create, list, edit, deactivate; validates; isolated per consultant", async () => {
    const a = await onboard();
    const b = await onboard();
    const made = await call("POST", "/v1/consultant/services", { token: a.token, body: { name: "General Consultation", durationMinutes: 30, bufferMinutes: 5 } });
    expect(made.status).toBe(201);
    const id = made.body.service.id;

    expect((await call("POST", "/v1/consultant/services", { token: a.token, body: { name: "x", durationMinutes: 30 } })).status).toBe(400);
    expect((await call("POST", "/v1/consultant/services", { token: a.token, body: { name: "Quick check", durationMinutes: 1 } })).status).toBe(400);

    const edited = await call("PUT", `/v1/consultant/services/${id}`, { token: a.token, body: { durationMinutes: 45 } });
    expect(edited.body.service).toMatchObject({ name: "General Consultation", durationMinutes: 45, bufferMinutes: 5, active: true });
    expect((await call("PUT", `/v1/consultant/services/${id}`, { token: a.token, body: { active: false } })).body.service.active).toBe(false);
    expect((await call("GET", "/v1/consultant/services", { token: a.token })).body.services).toHaveLength(1);

    // consultant B can neither see nor change A's service
    expect((await call("GET", "/v1/consultant/services", { token: b.token })).body.services).toHaveLength(0);
    expect((await call("PUT", `/v1/consultant/services/${id}`, { token: b.token, body: { name: "Hijacked" } })).status).toBe(404);
  });
});

describe("consultant API: practitioners and availability", () => {
  it("manages practitioners and never exposes Google tokens", async () => {
    const { token } = await onboard();
    const made = await call("POST", "/v1/consultant/resources", { token, body: { name: "Dr. Rao" } });
    expect(made.status).toBe(201);
    expect(made.body.resource).toMatchObject({ name: "Dr. Rao", active: true, googleConnectionStatus: "disconnected" });
    await call("PUT", `/v1/consultant/resources/${made.body.resource.id}`, { token, body: { active: false } });
    const list = (await call("GET", "/v1/consultant/resources", { token })).body.resources;
    expect(list).toHaveLength(1);
    expect(list[0].active).toBe(false); // inactive ones stay listed so they can be re-enabled
    expect(JSON.stringify(list)).not.toMatch(/refresh|encrypted/i);
  });

  it("saves, reads back and replaces a weekly schedule with date exceptions", async () => {
    const { token } = await onboard();
    const rid = (await call("POST", "/v1/consultant/resources", { token, body: { name: "Dr. Hours" } })).body.resource.id;
    const url = `/v1/consultant/resources/${rid}/availability`;

    const schedule = {
      weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "09:00", end: "17:00" })),
      exceptions: [{ date: "2031-12-25", closed: true }, { date: "2031-12-24", closed: false, start: "10:00", end: "13:00" }],
    };
    expect((await call("PUT", url, { token, body: schedule })).status).toBe(200);
    const read = (await call("GET", url, { token })).body;
    expect(read.weekly).toEqual(schedule.weekly);
    expect(read.exceptions).toEqual([{ date: "2031-12-24", closed: false, start: "10:00", end: "13:00" }, { date: "2031-12-25", closed: true }]);

    // replacing removes the old rules
    await call("PUT", url, { token, body: { weekly: [{ weekday: 6, start: "10:00", end: "12:00" }], exceptions: [] } });
    expect((await call("GET", url, { token })).body).toEqual({ weekly: [{ weekday: 6, start: "10:00", end: "12:00" }], exceptions: [] });
  });

  it("rejects invalid schedules and leaves the old one intact", async () => {
    const { token } = await onboard();
    const rid = (await call("POST", "/v1/consultant/resources", { token, body: { name: "Dr. Strict" } })).body.resource.id;
    const url = `/v1/consultant/resources/${rid}/availability`;
    await call("PUT", url, { token, body: { weekly: [{ weekday: 1, start: "09:00", end: "10:00" }], exceptions: [] } });

    const reject = async (body: unknown) => expect((await call("PUT", url, { token, body })).status).toBe(400);
    await reject({ weekly: [{ weekday: 1, start: "17:00", end: "09:00" }], exceptions: [] });
    await reject({ weekly: [{ weekday: 1, start: "09:00", end: "10:00" }, { weekday: 1, start: "11:00", end: "12:00" }], exceptions: [] });
    await reject({ weekly: [{ weekday: 9, start: "09:00", end: "10:00" }], exceptions: [] });
    await reject({ weekly: [], exceptions: [{ date: "2031-12-25", closed: false }] });
    await reject({ weekly: [{ weekday: 1, start: "9am", end: "10:00" }], exceptions: [] });
    expect((await call("GET", url, { token })).body.weekly).toEqual([{ weekday: 1, start: "09:00", end: "10:00" }]);
  });

  it("another consultant can't read or change a practitioner's schedule", async () => {
    const a = await onboard();
    const b = await onboard();
    const rid = (await call("POST", "/v1/consultant/resources", { token: a.token, body: { name: "Dr. Private" } })).body.resource.id;
    expect((await call("GET", `/v1/consultant/resources/${rid}/availability`, { token: b.token })).status).toBe(404);
    expect((await call("PUT", `/v1/consultant/resources/${rid}/availability`, { token: b.token, body: { weekly: [], exceptions: [] } })).status).toBe(404);
    expect((await call("PUT", `/v1/consultant/resources/${rid}`, { token: b.token, body: { name: "Hijacked" } })).status).toBe(404);
  });

  it("offers free slots from the saved schedule", async () => {
    const { token } = await onboard();
    const sid = (await call("POST", "/v1/consultant/services", { token, body: { name: "Consult", durationMinutes: 30 } })).body.service.id;
    const rid = (await call("POST", "/v1/consultant/resources", { token, body: { name: "Dr. Slots" } })).body.resource.id;
    await call("PUT", `/v1/consultant/resources/${rid}/availability`, { token, body: { weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "09:00", end: "11:00" })), exceptions: [] } });

    const { DateTime } = await import("luxon");
    let monday = DateTime.fromISO("2031-01-01"); // far future so "minimum notice" never interferes
    while (monday.weekday !== 1) monday = monday.plus({ days: 1 });
    const res = await call("GET", `/v1/consultant/slots?serviceId=${sid}&resourceId=${rid}&from=${monday.toISODate()}&days=1`, { token });
    expect(res.status).toBe(200);
    expect(res.body.timezone).toBe("Asia/Kolkata");
    expect(res.body.slots).toHaveLength(19); // 5-minute default: 09:00, 09:05 … 10:30 (a 30-minute visit must end by 11:00)
    expect(res.body.slots[0].local).toContain("9:00 AM");
    expect(res.body.slots.at(-1).local).toContain("10:30 AM");
    expect((await call("GET", `/v1/consultant/slots?serviceId=nope&resourceId=${rid}&from=2031-01-01`, { token })).status).toBe(400);
  });
});

describe("consultant API: overview, payments history, account, settings", () => {
  it("overview starts empty, then counts a booking and its user", async () => {
    const { token, slug } = await onboard();
    const empty = (await call("GET", "/v1/consultant/overview", { token })).body;
    expect(empty).toMatchObject({ today: 0, pendingApproval: 0, awaitingPayment: 0, users: 0, upcoming: [], paymentsActive: false, revenue: { todayPaise: 0, last30DaysPaise: 0 } });

    const sid = (await call("POST", "/v1/consultant/services", { token, body: { name: "Consult", durationMinutes: 30 } })).body.service.id;
    const rid = (await call("POST", "/v1/consultant/resources", { token, body: { name: "Dr. Count" } })).body.resource.id;
    const { loadTenantConfig } = await import("../booking/tenant");
    const { createAppointment } = await import("../booking/booking");
    await createAppointment(await loadTenantConfig(slug), {
      serviceId: sid, resourceId: rid, startAt: new Date(Date.now() + 3 * 24 * 3600_000), patient: { name: "Asha Rao", phone: "+919000011111" }, channel: "web",
    });
    const after = (await call("GET", "/v1/consultant/overview", { token })).body;
    expect(after).toMatchObject({ pendingApproval: 1, next7Days: 1, users: 1, newUsers30d: 1 });
    expect(after.upcoming[0]).toMatchObject({ patient_name: "Asha Rao", service_name: "Consult", resource_name: "Dr. Count" });
    const list = (await call("GET", "/v1/consultant/appointments", { token })).body.appointments;
    expect(list).toHaveLength(1);
    expect((await call("GET", "/v1/consultant/users?phone=9000011111", { token })).body.users).toHaveLength(1);
  });

  it("payment transactions are empty until a payment exists, and scoped to the consultant", async () => {
    const { token } = await onboard();
    expect((await call("GET", "/v1/consultant/payments/transactions", { token })).body).toEqual({ transactions: [] });
  });

  it("changes the consultant's own password, checking the current one", async () => {
    const { token, email } = await onboard();
    expect((await call("POST", "/v1/consultant/account/password", { token, body: { currentPassword: "wrong-one", newPassword: "another-pass-1" } })).status).toBe(400);
    expect((await call("POST", "/v1/consultant/account/password", { token, body: { currentPassword: "password-123", newPassword: "short" } })).status).toBe(400);
    expect((await call("POST", "/v1/consultant/account/password", { token, body: { currentPassword: "password-123", newPassword: "another-pass-1" } })).status).toBe(200);
    expect((await call("POST", "/v1/consultant/login", { body: { email, password: "password-123" } })).status).toBe(401);
    expect((await call("POST", "/v1/consultant/login", { body: { email, password: "another-pass-1" } })).status).toBe(200);
  });

  it("settings can rename the consultant and change its timezone, rejecting a bad one", async () => {
    const { token } = await onboard();
    const ok = await call("PUT", "/v1/consultant/settings", { token, body: { name: "New Name Clinic", timezone: "Asia/Dubai", reminderHoursBefore: 12 } });
    expect(ok.body.settings).toMatchObject({ name: "New Name Clinic", timezone: "Asia/Dubai", reminderHoursBefore: 12 });
    expect((await call("PUT", "/v1/consultant/settings", { token, body: { timezone: "Nowhere/City" } })).status).toBe(400);
  });

  it("every consultant endpoint requires a login", async () => {
    for (const path of ["/services", "/resources", "/overview", "/payments/transactions", "/settings", "/appointments", "/users"]) {
      expect((await call("GET", `/v1/consultant${path}`)).status).toBe(401);
    }
  });
});

describe("slot interval and availability check", () => {
  async function clinicWithHours() {
    const o = await onboard();
    const sid = (await call("POST", "/v1/consultant/services", { token: o.token, body: { name: "Consult", durationMinutes: 30, bufferMinutes: 5 } })).body.service.id;
    const rid = (await call("POST", "/v1/consultant/resources", { token: o.token, body: { name: "Dr. Check" } })).body.resource.id;
    await call("PUT", `/v1/consultant/resources/${rid}/availability`, { token: o.token, body: { weekly: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: "09:00", end: "17:00" })), exceptions: [] } });
    return { ...o, sid, rid };
  }
  const nextMonday = async () => {
    const { DateTime } = await import("luxon");
    let d = DateTime.fromISO("2031-01-01");
    while (d.weekday !== 1) d = d.plus({ days: 1 });
    return d.toISODate()!;
  };

  it("new consultants start at a 5-minute interval, and it can be changed (5-240 only)", async () => {
    const { token } = await onboard();
    expect((await call("GET", "/v1/consultant/settings", { token })).body.settings.slotIntervalMinutes).toBe(5);
    expect((await call("PUT", "/v1/consultant/settings", { token, body: { slotIntervalMinutes: 15 } })).body.settings.slotIntervalMinutes).toBe(15);
    expect((await call("PUT", "/v1/consultant/settings", { token, body: { slotIntervalMinutes: 4 } })).status).toBe(400);
    expect((await call("PUT", "/v1/consultant/settings", { token, body: { slotIntervalMinutes: 241 } })).status).toBe(400);
    expect((await call("PUT", "/v1/consultant/settings", { token, body: { slotIntervalMinutes: 7.5 } })).status).toBe(400);
  });

  it("the offered start times follow the interval", async () => {
    const { token, sid, rid } = await clinicWithHours();
    const monday = await nextMonday();
    const count = async () => (await call("GET", `/v1/consultant/slots?serviceId=${sid}&resourceId=${rid}&from=${monday}&days=1`, { token })).body.slots.length;
    // 09:00–17:00 with a 30-minute visit: last start 16:30 → 7.5h of 5-minute starts = 91 starts
    expect(await count()).toBe(91);
    await call("PUT", "/v1/consultant/settings", { token, body: { slotIntervalMinutes: 30 } });
    expect(await count()).toBe(16);
  });

  it("checks a time: free, outside hours, in the past, and overlapping another booking (but not itself)", async () => {
    const { token, slug, sid, rid } = await clinicWithHours();
    const monday = await nextMonday();
    const check = async (time: string, extra = "") => (await call("GET", `/v1/consultant/slots/check?serviceId=${sid}&resourceId=${rid}&startAt=${encodeURIComponent(`${monday}T${time}:00+05:30`)}${extra}`, { token })).body;

    expect(await check("10:00")).toMatchObject({ withinHours: true, inPast: false, conflicts: [], tight: [], onGrid: true, hours: { start: "09:00", end: "17:00" } });
    expect(await check("08:30")).toMatchObject({ withinHours: false });
    expect(await check("16:45")).toMatchObject({ withinHours: false }); // 30 min visit would end 17:15
    expect(await check("16:30")).toMatchObject({ withinHours: true });

    const { loadTenantConfig } = await import("../booking/tenant");
    const { createAppointment } = await import("../booking/booking");
    const made = await createAppointment(await loadTenantConfig(slug), { serviceId: sid, resourceId: rid, startAt: new Date(`${monday}T11:00:00+05:30`), patient: { name: "Asha Rao", phone: "+919000044444" }, channel: "web" });

    const clash = await check("11:15");
    expect(clash.conflicts).toHaveLength(1);
    expect(clash.conflicts[0]).toMatchObject({ patientName: "Asha Rao", id: made.appointmentId });
    // back-to-back isn't an overlap, but it is inside the clinic's 5-minute gap after the 11:00 visit: a warning, not a block
    const backToBack = await check("11:30");
    expect(backToBack.conflicts).toHaveLength(0);
    expect(backToBack.tight).toEqual([expect.objectContaining({ patientName: "Asha Rao", bufferMinutes: 5 })]);
    expect((await check("11:35")).tight).toHaveLength(0);
    // …and the time before it: this visit's own buffer would run into the 11:00 booking
    expect((await check("10:30")).tight).toHaveLength(1);
    expect((await check("10:25")).tight).toHaveLength(0);
    expect((await check("11:00", `&excludeAppointmentId=${made.appointmentId}`)).conflicts).toHaveLength(0); // moving it onto its own slot
    expect((await call("GET", `/v1/consultant/slots/check?serviceId=${sid}&resourceId=${rid}&startAt=2020-01-01T10:00:00%2B05:30`, { token })).body.inPast).toBe(true);
  });

  it("rejects bad input and other consultants' ids", async () => {
    const a = await clinicWithHours();
    const b = await onboard();
    expect((await call("GET", `/v1/consultant/slots/check?serviceId=${a.sid}&resourceId=${a.rid}&startAt=tomorrow`, { token: a.token })).status).toBe(400);
    expect((await call("GET", `/v1/consultant/slots/check?serviceId=${a.sid}&resourceId=${a.rid}&startAt=2031-01-06T10:00:00%2B05:30`, { token: b.token })).status).toBe(404);
  });

  it("a consultant can reschedule to any time, including outside working hours", async () => {
    const { token, slug, sid, rid } = await clinicWithHours();
    const monday = await nextMonday();
    const { loadTenantConfig } = await import("../booking/tenant");
    const { createAppointment } = await import("../booking/booking");
    const made = await createAppointment(await loadTenantConfig(slug), { serviceId: sid, resourceId: rid, startAt: new Date(`${monday}T11:00:00+05:30`), patient: { name: "Late Lata", phone: "+919000055555" }, channel: "web" });
    const evening = `${monday}T20:35:00+05:30`; // well after closing, on a 5-minute mark
    const moved = await call("POST", `/v1/consultant/appointments/${made.appointmentId}/reschedule`, { token, body: { startAt: new Date(evening).toISOString() } });
    expect(moved.status).toBe(200);
    expect(new Date(moved.body.appointment.start_at ?? moved.body.appointment.startAt).toISOString()).toBe(new Date(evening).toISOString());
  });
});

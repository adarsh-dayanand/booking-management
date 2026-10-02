// Needs the real test database (see concurrent-booking.integration.test.ts for setup).
// Proves the "no registration" identity model: the first message from a phone number creates the patient,
// every spelling of the number maps to the same patient, and web visitors authenticate with a WhatsApp OTP.

import "dotenv/config"; // must load before DATABASE_URL_TEST is read below
import { randomUUID } from "crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { TenantConfig } from "../types";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

const sent: { to: string; text: string }[] = [];
vi.mock("../channels/whatsapp", async (orig) => ({
  ...(await orig<typeof import("../channels/whatsapp")>()),
  deliver: async (_id: string | null, to: string, text: string) => {
    sent.push({ to, text });
    return "sent";
  },
}));

let pool: Pool;
let patients: typeof import("../booking/patients");
let otp: typeof import("../channels/phoneOtp");
let booking: typeof import("../booking/booking");
let tenantId: string;
let cfg: TenantConfig;

beforeAll(async () => {
  ({ pool } = await import("../lib/db"));
  patients = await import("../booking/patients");
  otp = await import("../channels/phoneOtp");
  booking = await import("../booking/booking");

  tenantId = (
    await pool.query(
      `INSERT INTO tenants (name, slug, timezone, confirmation_policy) VALUES ('Patients Test', $1, 'UTC', 'instant') RETURNING id`,
      [`patients-test-${randomUUID()}`]
    )
  ).rows[0].id;
  const serviceId = (await pool.query(`INSERT INTO services (tenant_id, name, duration_minutes) VALUES ($1, 'Consult', 30) RETURNING id`, [tenantId])).rows[0].id;
  const resourceId = (await pool.query(`INSERT INTO resources (tenant_id, name) VALUES ($1, 'Doc') RETURNING id`, [tenantId])).rows[0].id;
  cfg = {
    tenant: { id: tenantId, name: "Patients Test", slug: "x", timezone: "UTC", confirmationPolicy: "instant", whatsappPhoneNumberId: "pn1", staffWhatsappNumber: null, reminderHoursBefore: 24, faqText: null, paymentsEnabled: false, collectPayments: false, pricing: null },
    services: [{ id: serviceId, tenantId, name: "Consult", durationMinutes: 30, bufferMinutes: 0, active: true }],
    resources: [{ id: resourceId, tenantId, name: "Doc", googleCalendarId: null, googleRefreshTokenEncrypted: null, googleConnectionStatus: "disconnected", active: true }],
    availabilityRules: [],
  };
});

afterAll(async () => {
  for (const table of ["phone_otps", "appointments", "patients", "services", "resources"]) {
    await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
  }
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  await pool.end();
});

const count = async (phone: string) =>
  (await pool.query("SELECT count(*)::int AS n FROM patients WHERE tenant_id = $1 AND phone_normalized = $2", [tenantId, phone])).rows[0].n;

describe("patient capture from the first message", () => {
  it("creates the patient on first contact with the WhatsApp profile name, verified, and reuses it afterwards", async () => {
    const first = await patients.touchPatient(tenantId, "919811100001", { channel: "whatsapp", name: "Asha K", nameSource: "whatsapp_profile", verified: true });
    expect(first).toMatchObject({ name: "Asha K", nameSource: "whatsapp_profile", phoneVerified: true, firstChannel: "whatsapp", phoneNormalized: "919811100001" });

    const again = await patients.touchPatient(tenantId, "919811100001", { channel: "whatsapp", name: "Different Profile", nameSource: "whatsapp_profile", verified: true });
    expect(again.id).toBe(first.id);
    expect(again.name).toBe("Asha K"); // a later profile name doesn't churn the stored one
    expect(await count("919811100001")).toBe(1);
  });

  it("maps every way of writing the same number to one patient", async () => {
    const a = await patients.touchPatient(tenantId, "+91 98111 00002", { channel: "web" });
    const b = await patients.touchPatient(tenantId, "9811100002", { channel: "web" });
    const c = await patients.touchPatient(tenantId, "919811100002", { channel: "whatsapp", verified: true });
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);
    expect(await count("919811100002")).toBe(1);
    expect((await patients.getPatientByPhone(tenantId, "09811100002"))?.id).toBe(a.id);
  });

  it("a name the patient types replaces a profile name, and is never overwritten after that", async () => {
    await patients.touchPatient(tenantId, "919811100003", { channel: "whatsapp", name: "ashu❤", nameSource: "whatsapp_profile", verified: true });
    const p = await patients.touchPatient(tenantId, "919811100003", { channel: "whatsapp", name: "Asha Rao", nameSource: "patient" });
    expect(p).toMatchObject({ name: "Asha Rao", nameSource: "patient" });
    const after = await patients.touchPatient(tenantId, "919811100003", { channel: "whatsapp", name: "ashu❤", nameSource: "whatsapp_profile" });
    expect(after.name).toBe("Asha Rao");
  });

  it("verification is never downgraded by a later unverified contact", async () => {
    await patients.touchPatient(tenantId, "919811100004", { channel: "whatsapp", verified: true });
    const p = await patients.touchPatient(tenantId, "9811100004", { channel: "web" });
    expect(p.phoneVerified).toBe(true);
  });

  it("saves volunteered details, changing only the fields provided", async () => {
    const p = await patients.touchPatient(tenantId, "919811100005", { channel: "whatsapp", verified: true });
    const saved = await patients.updatePatientDetails(tenantId, p.id, { name: "Ravi Kumar", email: "ravi@example.com" });
    expect(saved).toMatchObject({ name: "Ravi Kumar", nameSource: "patient", email: "ravi@example.com", preferredLanguage: null });
    const more = await patients.updatePatientDetails(tenantId, p.id, { preferredLanguage: "Kannada", dateOfBirth: "1990-05-17" });
    expect(more).toMatchObject({ name: "Ravi Kumar", email: "ravi@example.com", preferredLanguage: "Kannada", dateOfBirth: "1990-05-17" });
  });

  it("admin search finds a patient by phone in any format, or by name", async () => {
    expect((await patients.searchPatients(tenantId, { phone: "+91 98111 00005" })).map((p) => p.name)).toEqual(["Ravi Kumar"]);
    expect((await patients.searchPatients(tenantId, { q: "ravi" })).length).toBe(1);
    expect(await patients.searchPatients(tenantId, { phone: "9000000000" })).toEqual([]);
  });
});

describe("bookings reuse the patient profile", () => {
  it("two bookings from one number share one patient; each keeps the name it was booked under", async () => {
    const [service] = cfg.services;
    const [resource] = cfg.resources;
    const book = (when: string, name: string) =>
      booking.createAppointment(cfg, { serviceId: service.id, resourceId: resource.id, startAt: new Date(when), patient: { name, phone: "+91 98111 00006" }, phoneVerified: true, channel: "whatsapp" });
    const one = await book("2031-03-03T10:00:00Z", "Meera S");
    const two = await book("2031-03-03T11:00:00Z", "Meera's Mother"); // booking for a family member on a shared phone

    expect(await count("919811100006")).toBe(1);
    const rows = (await pool.query("SELECT id, patient_id, patient_name FROM appointments WHERE id = ANY($1) ORDER BY start_at", [[one.appointmentId, two.appointmentId]])).rows;
    expect(rows[0].patient_id).toBe(rows[1].patient_id);
    expect(rows.map((r) => r.patient_name)).toEqual(["Meera S", "Meera's Mother"]);
    expect((await patients.getPatientByPhone(tenantId, "919811100006"))?.name).toBe("Meera S"); // profile keeps the first typed name
  });
});

describe("phone OTP authentication", () => {
  const phone = "98111 00007";
  const lastCode = () => sent.at(-1)!.text.match(/(\d{6})/)![1];

  it("sends a code over WhatsApp to the normalised number and verifies it once", async () => {
    expect(await otp.sendPhoneOtp(cfg.tenant, phone)).toEqual({ sent: true });
    expect(sent.at(-1)!.to).toBe("919811100007");
    const code = lastCode();

    expect(await otp.verifyPhoneOtp(tenantId, "+919811100007", "000000" === code ? "111111" : "000000")).toMatchObject({ verified: false });
    expect(await otp.verifyPhoneOtp(tenantId, phone, code)).toEqual({ verified: true, phone: "919811100007" });
    expect(await otp.verifyPhoneOtp(tenantId, phone, code)).toMatchObject({ verified: false }); // single use
  });

  it("locks out after 5 wrong guesses, even if the right code is then supplied", async () => {
    await otp.sendPhoneOtp(cfg.tenant, "9811100008");
    const code = lastCode();
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i++) expect(await otp.verifyPhoneOtp(tenantId, "9811100008", wrong)).toMatchObject({ verified: false });
    expect(await otp.verifyPhoneOtp(tenantId, "9811100008", code)).toMatchObject({ verified: false, error: expect.stringContaining("Too many") });
  });

  it("is scoped to the clinic and rate limited to 3 codes per hour per number", async () => {
    const otherTenant = randomUUID();
    expect(await otp.verifyPhoneOtp(otherTenant, "9811100007", "123456")).toMatchObject({ verified: false });
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await otp.sendPhoneOtp(cfg.tenant, "9811100009"));
    expect(results.slice(0, 3).every((r) => r.sent)).toBe(true);
    expect(results[3]).toMatchObject({ sent: false, error: expect.stringContaining("Too many") });
  });

  it("stores only a hash of the code", async () => {
    await otp.sendPhoneOtp(cfg.tenant, "9811100010");
    const code = lastCode();
    const row = (await pool.query("SELECT code_hash FROM phone_otps WHERE tenant_id = $1 AND phone_normalized = '919811100010'", [tenantId])).rows[0];
    expect(row.code_hash).not.toContain(code);
    expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

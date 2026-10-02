// Requires the real local test database (see concurrent-booking.integration.test.ts). Razorpay is mocked at the
// fetch boundary, so everything else — appointments, the slot-hold constraint, settlement, expiry — runs for real.

import "dotenv/config";
import { randomBytes, randomUUID } from "crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { TenantConfig } from "../types";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
process.env.CRYPTO_KEY = randomBytes(32).toString("base64");

let pool: Pool;
let booking: typeof import("../booking/booking");
let settlement: typeof import("../payments/settlement");
let errors: typeof import("../errors");
let encrypt: typeof import("../lib/crypto").encrypt;

let tenantId: string;
let serviceId: string;
let resourceId: string;

// --- fake Razorpay ---------------------------------------------------------
interface FakeLink { id: string; status: string; amount: number; amountPaid: number; paymentId?: string }
const links = new Map<string, FakeLink>();
const calls: string[] = [];
let failCreate = false;

function fakeRazorpay(url: string, init: RequestInit = {}): Response {
  const path = url.replace(/^.*\/v1/, "");
  const method = init.method ?? "GET";
  calls.push(`${method} ${path}`);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (method === "POST" && path === "/payment_links") {
    if (failCreate) return json({ error: { description: "boom" } }, 500);
    const body = JSON.parse(String(init.body));
    const id = `plink_${randomUUID().slice(0, 8)}`;
    links.set(id, { id, status: "created", amount: body.amount, amountPaid: 0 });
    return json({ id, short_url: `https://rzp.io/i/${id}`, status: "created", amount: body.amount, amount_paid: 0 });
  }
  const m = path.match(/^\/payment_links\/([^/]+)(\/cancel)?$/);
  if (m) {
    const link = links.get(m[1]);
    if (!link) return json({ error: { description: "not found" } }, 404);
    if (m[2]) link.status = "cancelled";
    return json({
      id: link.id, short_url: `https://rzp.io/i/${link.id}`, status: link.status, amount: link.amount, amount_paid: link.amountPaid,
      payments: link.paymentId ? [{ payment_id: link.paymentId, status: "captured" }] : [],
    });
  }
  return json({ error: { description: "unexpected" } }, 404);
}

const buildConfig = (over: Partial<TenantConfig["tenant"]> = {}): TenantConfig => ({
  tenant: {
    id: tenantId, name: "Pay Clinic", slug: "pay-clinic", timezone: "Asia/Kolkata", confirmationPolicy: "staff_approval",
    whatsappPhoneNumberId: null, staffWhatsappNumber: null, reminderHoursBefore: 24, faqText: null, slotIntervalMinutes: 5,
    paymentsEnabled: true, collectPayments: true, pricing: { mode: "flat", hourlyRate: 1000 }, ...over,
  },
  services: [{ id: serviceId, tenantId, name: "Consult", durationMinutes: 30, bufferMinutes: 0, active: true }],
  resources: [{ id: resourceId, tenantId, name: "Doc", googleCalendarId: null, googleRefreshTokenEncrypted: null, googleConnectionStatus: "disconnected", active: true }],
  availabilityRules: [],
});

let dayOffset = 0;
/** A fresh far-future slot per test so tests never collide on the no-overlap constraint. */
const nextSlot = () => new Date(Date.UTC(2031, 0, 1 + dayOffset++, 10, 0, 0));
const book = (config: TenantConfig, startAt: Date, phone = "+919000000001") =>
  booking.createAppointment(config, { serviceId, resourceId, startAt, patient: { name: "Pat Ient", phone }, channel: "web" });
const apptStatus = async (id: string) => (await pool.query("SELECT status FROM appointments WHERE id = $1", [id])).rows[0].status;
const payRow = async (apptId: string) => (await pool.query("SELECT * FROM payments WHERE appointment_id = $1", [apptId])).rows[0];
const setPolicy = (policy: string) => pool.query("UPDATE tenants SET confirmation_policy = $2 WHERE id = $1", [tenantId, policy]);

beforeAll(async () => {
  ({ pool } = await import("../lib/db"));
  booking = await import("../booking/booking");
  settlement = await import("../payments/settlement");
  errors = await import("../errors");
  ({ encrypt } = await import("../lib/crypto"));

  const t = await pool.query(
    `INSERT INTO tenants (name, slug, timezone, confirmation_policy, payments_enabled, razorpay_key_id, razorpay_key_secret_encrypted, razorpay_webhook_secret_encrypted)
     VALUES ('Pay Clinic', $1, 'Asia/Kolkata', 'staff_approval', true, 'rzp_test_abc12345', $2, $3) RETURNING id`,
    [`pay-clinic-${randomUUID()}`, encrypt("secret-xyz-123"), encrypt("whsec-xyz-123")]
  );
  tenantId = t.rows[0].id;
  serviceId = (await pool.query(`INSERT INTO services (tenant_id, name, duration_minutes) VALUES ($1, 'Consult', 30) RETURNING id`, [tenantId])).rows[0].id;
  resourceId = (await pool.query(`INSERT INTO resources (tenant_id, name) VALUES ($1, 'Doc') RETURNING id`, [tenantId])).rows[0].id;
});

beforeEach(async () => {
  links.clear();
  calls.length = 0;
  failCreate = false;
  await setPolicy("staff_approval");
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => fakeRazorpay(String(url), init)));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const table of ["payments", "appointments", "patients", "services", "resources"]) {
    await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
  }
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  await pool.end();
});

describe("booking is held, not confirmed, until paid", () => {
  it("creates an AWAITING_PAYMENT hold with a payment link for the quoted fee", async () => {
    const result = await book(buildConfig(), nextSlot());
    expect(result.status).toBe("AWAITING_PAYMENT");
    expect(result.payment).toMatchObject({ amount: "₹500", amountPaise: 50_000 });
    expect(result.payment!.url).toMatch(/^https:\/\/rzp\.io\/i\/plink_/);

    const pay = await payRow(result.appointmentId);
    expect(pay).toMatchObject({ status: "created", amount_paise: 50_000, band: "flat" });
    expect(pay.razorpay_payment_link_id).toBeTruthy();
  });

  it("the unpaid hold blocks the slot for everyone else", async () => {
    const start = nextSlot();
    await book(buildConfig(), start);
    await expect(book(buildConfig(), start, "+919000000002")).rejects.toBeInstanceOf(errors.SlotConflictError);
  });

  it("charges per the variable rate card (weekend vs weekday)", async () => {
    const config = buildConfig({ pricing: { mode: "variable", weekdayRate: 1000, weekendRate: 1600, nightRate: 2000, nightStart: "20:00", nightEnd: "06:00" } });
    const saturdayNoonIst = new Date("2031-03-01T06:30:00Z"); // Saturday 12:00 IST
    const mondayNoonIst = new Date("2031-03-03T06:30:00Z");
    expect((await book(config, saturdayNoonIst)).payment!.amountPaise).toBe(80_000);
    expect((await book(config, mondayNoonIst)).payment!.amountPaise).toBe(50_000);
  });

  it("does not ask for payment when the admin hasn't enabled it, or the clinic has switched it off", async () => {
    for (const over of [{ paymentsEnabled: false }, { collectPayments: false }, { pricing: null }]) {
      const result = await book(buildConfig(over), nextSlot());
      expect(result.status).toBe("PENDING_CONFIRMATION");
      expect(result.payment).toBeUndefined();
    }
    expect(calls).toHaveLength(0); // Razorpay was never contacted
  });

  it("a free (₹0) fee skips payment", async () => {
    const result = await book(buildConfig({ pricing: { mode: "flat", hourlyRate: 0 } }), nextSlot());
    expect(result.status).toBe("PENDING_CONFIRMATION");
  });

  it("releases the slot and reports a clear error when Razorpay is down", async () => {
    failCreate = true;
    const start = nextSlot();
    await expect(book(buildConfig(), start)).rejects.toBeInstanceOf(errors.ValidationError);
    failCreate = false;
    expect((await book(buildConfig(), start)).status).toBe("AWAITING_PAYMENT"); // slot is free again
  });

  it("is idempotent: retrying with the same key returns the same payment link", async () => {
    const key = randomUUID();
    const input = { serviceId, resourceId, startAt: nextSlot(), patient: { name: "Pat Ient", phone: "+919000000003" }, channel: "web" as const, idempotencyKey: key };
    const first = await booking.createAppointment(buildConfig(), input);
    const second = await booking.createAppointment(buildConfig(), input);
    expect(second.appointmentId).toBe(first.appointmentId);
    expect(second.payment?.url).toBe(first.payment?.url);
    expect(links.size).toBe(1);
  });
});

describe("settling a payment", () => {
  const pay = async (apptId: string, over: Partial<{ amountPaid: number; paymentId: string | null }> = {}) => {
    const row = await payRow(apptId);
    return settlement.settlePaidLink(tenantId, { id: row.razorpay_payment_link_id, amountPaid: row.amount_paise, paymentId: "pay_123", ...over });
  };

  it("staff-approval clinic: payment moves the booking to PENDING_CONFIRMATION (the doctor still decides)", async () => {
    const { appointmentId } = await book(buildConfig(), nextSlot());
    expect(await pay(appointmentId)).toBe("confirmed");
    expect(await apptStatus(appointmentId)).toBe("PENDING_CONFIRMATION");
    expect(await payRow(appointmentId)).toMatchObject({ status: "paid", razorpay_payment_id: "pay_123" });
  });

  it("instant clinic: payment confirms the booking", async () => {
    await setPolicy("instant");
    const { appointmentId } = await book(buildConfig({ confirmationPolicy: "instant" }), nextSlot());
    expect(await pay(appointmentId)).toBe("confirmed");
    expect(await apptStatus(appointmentId)).toBe("CONFIRMED");
  });

  it("is idempotent: webhook redelivery or a poll racing the webhook settles once", async () => {
    const { appointmentId } = await book(buildConfig(), nextSlot());
    const results = await Promise.all([pay(appointmentId), pay(appointmentId), pay(appointmentId)]);
    expect(results.filter((r) => r === "confirmed")).toHaveLength(1);
    expect(results.filter((r) => r === "already_settled")).toHaveLength(2);
    expect(await apptStatus(appointmentId)).toBe("PENDING_CONFIRMATION");
  });

  it("rejects an underpayment and leaves the booking on hold", async () => {
    const { appointmentId } = await book(buildConfig(), nextSlot());
    expect(await pay(appointmentId, { amountPaid: 100 })).toBe("amount_mismatch");
    expect(await apptStatus(appointmentId)).toBe("AWAITING_PAYMENT");
    expect((await payRow(appointmentId)).status).toBe("created");
  });

  it("won't settle another clinic's link, or an unknown one", async () => {
    const { appointmentId } = await book(buildConfig(), nextSlot());
    const row = await payRow(appointmentId);
    expect(await settlement.settlePaidLink(randomUUID(), { id: row.razorpay_payment_link_id, amountPaid: row.amount_paise, paymentId: "p" })).toBe("unknown_link");
    expect(await settlement.settlePaidLink(tenantId, { id: "plink_nope", amountPaid: 1, paymentId: "p" })).toBe("unknown_link");
    expect(await apptStatus(appointmentId)).toBe("AWAITING_PAYMENT");
  });

  it("money arriving for a booking that was already cancelled is flagged, not silently confirmed", async () => {
    const { appointmentId } = await book(buildConfig(), nextSlot());
    await pool.query("UPDATE appointments SET status = 'CANCELLED' WHERE id = $1", [appointmentId]);
    expect(await pay(appointmentId)).toBe("orphaned");
    expect(await apptStatus(appointmentId)).toBe("CANCELLED");
    expect((await payRow(appointmentId)).status).toBe("paid"); // recorded, so a human can refund it
  });
});

describe("reconciling with Razorpay (no webhook needed)", () => {
  it("confirms the booking when Razorpay says the link is paid", async () => {
    const { appointmentId } = await book(buildConfig(), nextSlot());
    const row = await payRow(appointmentId);
    Object.assign(links.get(row.razorpay_payment_link_id)!, { status: "paid", amountPaid: 50_000, paymentId: "pay_abc" });

    const state = await settlement.reconcileAppointment(tenantId, appointmentId);
    expect(state).toEqual({ paymentStatus: "paid", appointmentStatus: "PENDING_CONFIRMATION" });
  });

  it("keeps waiting while the link is unpaid", async () => {
    const { appointmentId } = await book(buildConfig(), nextSlot());
    expect(await settlement.reconcileAppointment(tenantId, appointmentId)).toEqual({ paymentStatus: "created", appointmentStatus: "AWAITING_PAYMENT" });
  });

  it("returns null for an appointment that never needed payment", async () => {
    const free = await book(buildConfig({ collectPayments: false }), nextSlot());
    expect(await settlement.reconcileAppointment(tenantId, free.appointmentId)).toBeNull();
  });
});

describe("unpaid holds expire", () => {
  it("releases the slot after the payment window and lets someone else book it", async () => {
    const start = nextSlot();
    const { appointmentId } = await book(buildConfig(), start);
    await pool.query("UPDATE payments SET expires_at = now() - interval '1 minute' WHERE appointment_id = $1", [appointmentId]);

    await settlement.expireUnpaidHolds();
    expect(await apptStatus(appointmentId)).toBe("CANCELLED");
    expect((await payRow(appointmentId)).status).toBe("expired");
    expect(calls.some((c) => c.endsWith("/cancel"))).toBe(true); // the link is killed so it can't be paid late
    expect((await book(buildConfig(), start, "+919000000009")).status).toBe("AWAITING_PAYMENT");
  });

  it("but never expires a hold that was actually paid just before the deadline", async () => {
    const { appointmentId } = await book(buildConfig(), nextSlot());
    const row = await payRow(appointmentId);
    Object.assign(links.get(row.razorpay_payment_link_id)!, { status: "paid", amountPaid: 50_000, paymentId: "pay_late" });
    await pool.query("UPDATE payments SET expires_at = now() - interval '1 minute' WHERE appointment_id = $1", [appointmentId]);

    await settlement.expireUnpaidHolds();
    expect(await apptStatus(appointmentId)).toBe("PENDING_CONFIRMATION");
    expect((await payRow(appointmentId)).status).toBe("paid");
  });

  it("leaves holds inside their window alone", async () => {
    const { appointmentId } = await book(buildConfig(), nextSlot());
    await settlement.expireUnpaidHolds();
    expect(await apptStatus(appointmentId)).toBe("AWAITING_PAYMENT");
  });
});

describe("cancelling an unpaid booking", () => {
  it("kills the payment link and frees the slot", async () => {
    const start = nextSlot();
    const { appointmentId } = await book(buildConfig(), start);
    await booking.cancelAppointment(buildConfig(), appointmentId, "changed my mind", "patient");

    expect(await apptStatus(appointmentId)).toBe("CANCELLED");
    expect((await payRow(appointmentId)).status).toBe("cancelled");
    expect(calls.some((c) => c.endsWith("/cancel"))).toBe(true);
    expect((await book(buildConfig(), start, "+919000000010")).status).toBe("AWAITING_PAYMENT");
  });

  it("staff can't approve a booking that hasn't been paid", async () => {
    const { appointmentId } = await book(buildConfig(), nextSlot());
    await expect(booking.approveAppointment(buildConfig(), appointmentId)).rejects.toBeInstanceOf(errors.ValidationError);
  });
});

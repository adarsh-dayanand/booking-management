// The numbered chat flow shows a menu of times, then books the one picked a little later. Between the two another
// booking may have taken that time — or only the clinic's buffer around it, which the database can't see.

import "dotenv/config";
import { randomUUID } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

let pool: Pool;
let handle: typeof import("../chat/guidedFlow").handleGuidedMessage;
let booking: typeof import("../booking/booking");
let loadTenantConfig: typeof import("../booking/tenant").loadTenantConfig;
let slug: string;
let tenantId: string;
let serviceId: string;
let resourceId: string;

// Far-future Monday, 09:00-17:00 IST. The service is 30 min with a 10-minute buffer; slots every 30 minutes.
const MON = "2031-01-06";
const at = (hhmm: string) => new Date(`${MON}T${hhmm}:00+05:30`);

beforeAll(async () => {
  ({ pool } = await import("../lib/db"));
  ({ handleGuidedMessage: handle } = await import("../chat/guidedFlow"));
  booking = await import("../booking/booking");
  ({ loadTenantConfig } = await import("../booking/tenant"));
  slug = `guided-${randomUUID().slice(0, 8)}`;
  tenantId = (await pool.query(`INSERT INTO tenants (name, slug, timezone, confirmation_policy, slot_interval_minutes) VALUES ('Guided Clinic', $1, 'Asia/Kolkata', 'instant', 30) RETURNING id`, [slug])).rows[0].id;
  serviceId = (await pool.query(`INSERT INTO services (tenant_id, name, duration_minutes, buffer_minutes) VALUES ($1, 'Consult', 30, 10) RETURNING id`, [tenantId])).rows[0].id;
  resourceId = (await pool.query(`INSERT INTO resources (tenant_id, name) VALUES ($1, 'Dr. G') RETURNING id`, [tenantId])).rows[0].id;
  await pool.query(`INSERT INTO availability_rules (tenant_id, resource_id, weekday, start_time, end_time) VALUES ($1, $2, 1, '09:00', '17:00')`, [tenantId, resourceId]);
});

afterAll(async () => {
  for (const table of ["appointments", "patients", "availability_rules", "services", "resources", "conversations"]) await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  await pool.end();
});

const say = (session: string, text: string) => handle(slug, "web", session, text);
const appointmentsFor = async (phoneDigits: string) =>
  (await pool.query(`SELECT a.* FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.tenant_id = $1 AND p.phone_normalized = $2`, [tenantId, phoneDigits])).rows;

/** Walk the menu up to the confirmation prompt for the first offered time that is on `day`. */
async function reachConfirmation(session: string, phone: string) {
  await say(session, "hi");
  const slots = await say(session, "1"); // the service; one practitioner, so the times come straight away
  const options = slots.options!;
  await say(session, options[0].id);
  await say(session, "Test Person");
  const confirm = await say(session, phone);
  expect(confirm.replyText).toContain("Please confirm");
  return { confirm, pickedLabel: options[0].label };
}

describe("the numbered chat flow re-checks before booking", () => {
  it("books normally when nothing changed", async () => {
    const { confirm } = await reachConfirmation(randomUUID(), "9100000001");
    expect(confirm.options?.[0].id).toBe("yes");
    const session = randomUUID();
    await reachConfirmation(session, "9100000002");
    const done = await say(session, "yes");
    expect(done.appointmentId).toBeTruthy();
    expect(done.replyText).toContain("confirmed");
    expect(await appointmentsFor("919100000002")).toHaveLength(1);
  });

  it("re-offers fresh times — and books nothing — if the picked time was taken meanwhile", async () => {
    const session = randomUUID();
    const { pickedLabel } = await reachConfirmation(session, "9100000003");
    // someone else books exactly that time while the patient is deciding
    const cfg = await loadTenantConfig(slug);
    const pending = (await pool.query(`SELECT state FROM conversations WHERE tenant_id = $1 AND external_id = $2`, [tenantId, session])).rows[0].state;
    await booking.createAppointment(cfg, { serviceId, resourceId, startAt: new Date(pending.selectedSlot.startAt), patient: { name: "Faster Fred", phone: "+919100000099" }, channel: "web" });

    const reply = await say(session, "yes");
    expect(reply.replyText).toContain("no longer available");
    expect(reply.appointmentId).toBeUndefined();
    expect(reply.options?.length).toBeGreaterThan(0); // fresh choices, ready to pick from
    expect(reply.options!.map((o) => o.label).join()).not.toContain(pickedLabel.replace(/^\d+\.\s*/, "")); // the taken time isn't offered again
    expect(await appointmentsFor("919100000003")).toHaveLength(0);
  });

  it("also catches a neighbour that only breaks the buffer (which the database's overlap rule cannot see)", async () => {
    // pick the time two slots from the start so a neighbour fits on either side
    const session = randomUUID();
    await say(session, "hi");
    const slots = await say(session, "1");
    const second = slots.options![1];
    await say(session, second.id);
    await say(session, "Buffer Person");
    await say(session, "9100000004");
    const pending = (await pool.query(`SELECT state FROM conversations WHERE tenant_id = $1 AND external_id = $2`, [tenantId, session])).rows[0].state;
    const picked = new Date(pending.selectedSlot.startAt);

    // another visit ends exactly when the picked one starts: no overlap, but its 10-minute buffer is still running
    const cfg = await loadTenantConfig(slug);
    await booking.createAppointment(cfg, { serviceId, resourceId, startAt: new Date(picked.getTime() - 30 * 60_000), patient: { name: "Neighbour Nan", phone: "+919100000098" }, channel: "web" });

    const reply = await say(session, "yes");
    expect(reply.replyText).toContain("no longer available");
    expect(await appointmentsFor("919100000004")).toHaveLength(0);
  });
});

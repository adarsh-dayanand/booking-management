// Real database: explains exactly why a time can't be booked, and proves availability lookups see bookings that start
// just beyond the window being searched. See concurrent-booking.integration.test.ts for the test-DB setup.

import "dotenv/config";
import { randomUUID } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { TenantConfig } from "../types";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

let pool: Pool;
let booking: typeof import("../booking/booking");
let diagnoseTime: typeof import("../booking/availability").diagnoseTime;
let loadTenantConfigById: typeof import("../booking/tenant").loadTenantConfigById;
let tenantId: string;
let serviceId: string;
let resourceId: string;

const IST = "+05:30";
// 2031-01-06 is a Monday, 2031-01-11 a Saturday. The clinic works Mon-Fri 09:00-17:00 IST.
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00${IST}`);
const MON = "2031-01-06";
const SAT = "2031-01-11";
const LONG_BEFORE = new Date("2031-01-01T00:00:00Z");

const config = async (): Promise<TenantConfig> => loadTenantConfigById(tenantId);
const hhmm = (iso: string) => new Date(Date.parse(iso) + 330 * 60_000).toISOString().slice(11, 16);

beforeAll(async () => {
  ({ pool } = await import("../lib/db"));
  booking = await import("../booking/booking");
  ({ diagnoseTime } = await import("../booking/availability"));
  ({ loadTenantConfigById } = await import("../booking/tenant"));

  tenantId = (await pool.query(`INSERT INTO tenants (name, slug, timezone, confirmation_policy) VALUES ('Avail Clinic', $1, 'Asia/Kolkata', 'staff_approval') RETURNING id`, [`avail-${randomUUID()}`])).rows[0].id;
  serviceId = (await pool.query(`INSERT INTO services (tenant_id, name, duration_minutes, buffer_minutes) VALUES ($1, 'Consult', 25, 5) RETURNING id`, [tenantId])).rows[0].id;
  resourceId = (await pool.query(`INSERT INTO resources (tenant_id, name) VALUES ($1, 'Dr. Avail') RETURNING id`, [tenantId])).rows[0].id;
  for (const weekday of [1, 2, 3, 4, 5]) {
    await pool.query(`INSERT INTO availability_rules (tenant_id, resource_id, weekday, start_time, end_time) VALUES ($1, $2, $3, '09:00', '17:00')`, [tenantId, resourceId, weekday]);
  }
  const cfg = await config();
  await booking.createAppointment(cfg, { serviceId, resourceId, startAt: at(MON, "11:00"), patient: { name: "Booked Bea", phone: "+919000077777" }, channel: "web" });
});

afterAll(async () => {
  for (const table of ["payments", "appointments", "patients", "availability_rules", "services", "resources"]) await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  await pool.end();
});

const check = async (day: string, time: string, now = LONG_BEFORE) => diagnoseTime(await config(), resourceId, serviceId, at(day, time), now);

describe("diagnoseTime: a free time is free", () => {
  it("says available for an open, unbooked, on-grid time (the service's 30-minute step from opening)", async () => {
    for (const t of ["09:00", "10:00", "13:30", "14:00", "16:30"]) expect(await check(MON, t)).toMatchObject({ available: true });
  });
});

describe("diagnoseTime: says why a time can't be booked", () => {
  it("a day the practitioner doesn't work", async () => {
    const r: any = await check(SAT, "10:00");
    expect(r).toMatchObject({ available: false, reason: "closed_day" });
    expect(r.message).toContain("isn't working on Saturday");
    expect(r.nearest.length).toBeGreaterThan(0); // points at the next working day instead
    expect(new Date(r.nearest[0].startAt).getTime()).toBeGreaterThan(at(SAT, "10:00").getTime());
  });

  it("outside opening hours, including a visit that would run past closing", async () => {
    const early: any = await check(MON, "08:30");
    expect(early).toMatchObject({ available: false, reason: "outside_hours" });
    expect(early.message).toContain("9:00 AM to 5:00 PM");
    expect(early.nearest.map((s: any) => hhmm(s.startAt))[0]).toBe("09:00");
    expect(await check(MON, "16:45")).toMatchObject({ available: false, reason: "outside_hours" }); // 25 min visit ends 17:10
    expect(await check(MON, "16:30")).toMatchObject({ available: true });
  });

  it("an existing booking — true overlap — without naming who has it", async () => {
    const r: any = await check(MON, "11:15");
    expect(r).toMatchObject({ available: false, reason: "booked" });
    expect(r.message).not.toContain("Bea");
    for (const s of r.nearest) expect(await check(MON, hhmm(s.startAt))).toMatchObject({ available: true }); // alternatives are real
    expect(r.nearest.map((s: any) => hhmm(s.startAt))).not.toContain("11:15");
  });

  it("right before a booking, where only the clinic's buffer is in the way", async () => {
    // 10:35 + 25 min ends at 11:00, but the 5-minute buffer would run into the 11:00 visit
    const r: any = await check(MON, "10:35");
    expect(r).toMatchObject({ available: false, reason: "too_close" });
    expect(r.message).toContain("5-minute gap");
    expect(await check(MON, "10:30")).toMatchObject({ available: true }); // ends 10:55, buffer ends exactly at 11:00
  });

  it("right AFTER a visit, while its buffer is still running — and says when the next start is", async () => {
    // the 11:00-11:25 visit's service has a 5-minute buffer, so it holds the practitioner until 11:30
    const r: any = await check(MON, "11:25");
    expect(r).toMatchObject({ available: false, reason: "too_close" });
    expect(r.message).toContain("right after another appointment");
    expect(r.message).toContain("earliest start there is 11:30 AM");
    expect(await check(MON, "11:30")).toMatchObject({ available: true });
  });

  it("not one of the service's start times (every duration + buffer = 30 minutes from opening)", async () => {
    expect(await check(MON, "10:00")).toMatchObject({ available: true });
    const r: any = await check(MON, "10:10"); // free, but between the 10:00 and 10:30 starts
    expect(r).toMatchObject({ available: false, reason: "not_on_interval" });
    expect(r.message).toContain("every 30 minutes starting at 9:00 AM");
    for (const s of r.nearest) { // every alternative is one of the service's real start times (09:00 + n × 30 min)
      const [h, m] = (hhmm(s.startAt) as string).split(":").map(Number);
      expect((h * 60 + m - 9 * 60) % 30).toBe(0);
    }
  });

  it("the past, and too soon for the clinic's minimum notice", async () => {
    const now = at(MON, "10:50");
    expect(await check(MON, "10:45", now)).toMatchObject({ available: false, reason: "past" });
    expect(await check(MON, "11:10", now)).toMatchObject({ available: false, reason: "too_soon" });
    expect(await check(MON, "12:00", now)).toMatchObject({ available: true });
  });

  it("offers alternatives near the requested time, in time order, each a genuinely different choice", async () => {
    const r: any = await check(MON, "11:15");
    const mins = r.nearest.map((s: any) => { const [h, m] = hhmm(s.startAt).split(":").map(Number); return h * 60 + m; });
    expect(mins).toHaveLength(4);
    expect(mins).toEqual([...mins].sort((a, b) => a - b));
    for (let i = 1; i < mins.length; i++) expect(mins[i] - mins[i - 1]).toBeGreaterThanOrEqual(25); // not 11:35, 11:40, 11:45…
    expect(mins.some((m: number) => m < 11 * 60 + 15)).toBe(true); // something earlier…
    expect(mins.some((m: number) => m > 11 * 60 + 15)).toBe(true); // …and something later
  });
});

describe("moving an appointment must not collide with itself", () => {
  const bookedId = async () => (await pool.query(`SELECT id FROM appointments WHERE tenant_id = $1 AND status IN ('PENDING_CONFIRMATION','CONFIRMED') AND patient_name = 'Booked Bea'`, [tenantId])).rows[0].id as string;

  it("re-picking the 11:00 visit's own time overlaps only itself, so it is allowed — and still refused for anyone else", async () => {
    const id = await bookedId();
    const cfg = await config();
    expect(await diagnoseTime(cfg, resourceId, serviceId, at(MON, "11:00"), LONG_BEFORE)).toMatchObject({ available: false, reason: "booked" });
    expect(await diagnoseTime(cfg, resourceId, serviceId, at(MON, "11:00"), LONG_BEFORE, id)).toMatchObject({ available: true });
  });

  it("the exclusion only lifts the moved appointment's own hold — other visits still block", async () => {
    const id = await bookedId();
    const cfg = await config();
    // put a second visit at 12:00 and try to move the 11:00 one onto it
    const other = await booking.createAppointment(cfg, { serviceId, resourceId, startAt: at(MON, "12:00"), patient: { name: "Other Olive", phone: "+919000066666" }, channel: "web" });
    try {
      expect(await diagnoseTime(cfg, resourceId, serviceId, at(MON, "12:00"), LONG_BEFORE, id)).toMatchObject({ available: false, reason: "booked" });
      expect(await diagnoseTime(cfg, resourceId, serviceId, at(MON, "12:15"), LONG_BEFORE, id)).toMatchObject({ available: false });
      expect(await diagnoseTime(cfg, resourceId, serviceId, at(MON, "11:00"), LONG_BEFORE, id)).toMatchObject({ available: true });
    } finally {
      await pool.query("DELETE FROM appointments WHERE id = $1", [other.appointmentId]); // leave the shared fixture as it was
    }
  });

  it("offers fresh alternatives that also ignore the moved appointment's own hold", async () => {
    const id = await bookedId();
    const r: any = await diagnoseTime(await config(), resourceId, serviceId, at(MON, "08:30"), LONG_BEFORE, id); // before opening
    expect(r).toMatchObject({ available: false, reason: "outside_hours" });
    expect(r.nearest.length).toBeGreaterThan(0);
    for (const s of r.nearest) expect(await diagnoseTime(await config(), resourceId, serviceId, new Date(s.startAt), LONG_BEFORE, id)).toMatchObject({ available: true });
  });
});

describe("availability sees bookings that start just past the window", () => {
  it("doesn't offer a time whose visit would run into a booking that begins after the search window ends", async () => {
    const cfg = await config();
    // The 11:00 booking lies beyond this window (09:00-10:55) but a visit starting 10:35 (+25 min +5 buffer) reaches it.
    // (Checked at 5-minute granularity: on the service's own 30-minute grid no neighbour can reach it.)
    const slots = await booking.generateAvailableSlots(cfg, resourceId, serviceId, at(MON, "09:00"), at(MON, "10:55"), { now: LONG_BEFORE, slotGranularityMinutes: 5 });
    const starts = slots.map((s) => hhmm(s.startAt));
    expect(starts).toContain("10:30");
    for (const t of ["10:35", "10:40", "10:50", "10:55"]) expect(starts).not.toContain(t);
  });

  it("lists every on-grid start across the day except those blocked by the booking", async () => {
    const cfg = await config();
    const slots = await booking.generateAvailableSlots(cfg, resourceId, serviceId, at(MON, "00:00"), at(MON, "23:59"), { now: LONG_BEFORE });
    const starts = slots.map((s) => hhmm(s.startAt));
    expect(starts[0]).toBe("09:00");
    expect(starts.at(-1)).toBe("16:30");
    // every offered start is on the service's 30-minute grid (25-minute visit + 5-minute buffer), and the 11:00 booking is skipped
    for (const t of starts) { const [h, m] = t.split(":").map(Number); expect((h * 60 + m - 9 * 60) % 30).toBe(0); }
    expect(starts).toContain("10:30"); // its buffer ends exactly when the 11:00 visit starts
    expect(starts).not.toContain("11:00");
    expect(starts).toContain("11:30"); // the 11:00 visit's buffer is over
    expect(starts).toHaveLength(15); // 09:00…16:30 every 30 minutes, minus 11:00
  });
});

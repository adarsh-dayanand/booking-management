// Property-style test against the real database. For many combinations of service durations and
// buffers, it keeps booking whatever the system offers and, after every booking, checks the rules that must always hold:
//   • every offered start is on the service's own grid (duration + buffer from opening) and inside working hours
//   • no offered slot overlaps an existing visit, and every visit keeps ITS buffer free (after it) and the new visit's
//     own buffer fits before the next one — i.e. buffers are symmetric
//   • "is this time free?" (diagnoseTime) agrees exactly with "is this time offered?" (generateAvailableSlots)
//   • booking an offered slot never fails with a conflict
// See concurrent-booking.integration.test.ts for the test-DB setup.

import "dotenv/config";
import { randomUUID } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

let pool: Pool;
let booking: typeof import("../booking/booking");
let diagnoseTime: typeof import("../booking/availability").diagnoseTime;
let loadTenantConfigById: typeof import("../booking/tenant").loadTenantConfigById;
let tenantId: string;
let resourceId: string;
const services: { id: string; duration: number; buffer: number }[] = [];

const DAY = "2031-01-06"; // a Monday
const OPEN = 9 * 60 + 15; // opens 09:15, deliberately not on the hour: the grid is anchored at opening time
const CLOSE = 17 * 60;
const LONG_BEFORE = new Date("2031-01-01T00:00:00Z");
const at = (min: number) => new Date(`${DAY}T00:00:00+05:30`).getTime() + min * 60_000;
const minuteOfDay = (iso: string | Date) => Math.round((new Date(iso).getTime() - at(0)) / 60_000);
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// small seeded PRNG so a failure is reproducible
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

beforeAll(async () => {
  ({ pool } = await import("../lib/db"));
  booking = await import("../booking/booking");
  ({ diagnoseTime } = await import("../booking/availability"));
  ({ loadTenantConfigById } = await import("../booking/tenant"));
  tenantId = (await pool.query(`INSERT INTO tenants (name, slug, timezone, confirmation_policy) VALUES ('Consistency', $1, 'Asia/Kolkata', 'instant') RETURNING id`, [`cons-${randomUUID()}`])).rows[0].id;
  resourceId = (await pool.query(`INSERT INTO resources (tenant_id, name) VALUES ($1, 'Dr. C') RETURNING id`, [tenantId])).rows[0].id;
  await pool.query(`INSERT INTO availability_rules (tenant_id, resource_id, weekday, start_time, end_time) VALUES ($1, $2, 1, '09:15', '17:00')`, [tenantId, resourceId]);
  for (const [duration, buffer] of [[15, 0], [30, 5], [45, 15], [60, 10]]) {
    const id = (await pool.query(`INSERT INTO services (tenant_id, name, duration_minutes, buffer_minutes) VALUES ($1, $2, $3, $4) RETURNING id`, [tenantId, `S${duration}`, duration, buffer])).rows[0].id;
    services.push({ id, duration, buffer });
  }
});

afterAll(async () => {
  for (const table of ["payments", "appointments", "patients", "availability_rules", "services", "resources"]) await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  await pool.end();
});

const liveVisits = async () =>
  (await pool.query(
    `SELECT a.start_at, a.end_at, s.buffer_minutes FROM appointments a JOIN services s ON s.id = a.service_id
     WHERE a.tenant_id = $1 AND a.status IN ('AWAITING_PAYMENT', 'PENDING_CONFIRMATION', 'CONFIRMED')`,
    [tenantId]
  )).rows.map((r) => ({ start: minuteOfDay(r.start_at), end: minuteOfDay(r.end_at), buffer: r.buffer_minutes as number }));

const offered = async (service: (typeof services)[number]) =>
  (await booking.generateAvailableSlots(await loadTenantConfigById(tenantId), resourceId, service.id, new Date(at(0)), new Date(at(24 * 60 - 1)), { now: LONG_BEFORE })).map((s) => minuteOfDay(s.startAt));

async function checkInvariants(label: string) {
  const visits = await liveVisits();
  const config = await loadTenantConfigById(tenantId);
  for (const service of services) {
    const starts = await offered(service);
    const where = `${label}, service ${service.duration}+${service.buffer}`;
    const step = service.duration + service.buffer;
    for (const t of starts) {
      const end = t + service.duration;
      expect(t >= OPEN && end <= CLOSE, `${where}: ${hhmm(t)} is outside working hours`).toBe(true);
      expect((t - OPEN) % step, `${where}: ${hhmm(t)} is off the ${step}-minute grid`).toBe(0);
      for (const v of visits) {
        expect(t < v.end && v.start < end, `${where}: ${hhmm(t)} overlaps the visit at ${hhmm(v.start)}-${hhmm(v.end)}`).toBe(false);
        // each visit reserves its length + ITS buffer; the new visit needs its own buffer free before the next one starts
        const blockedByBefore = t < v.end + v.buffer && v.start < end + service.buffer;
        expect(blockedByBefore, `${where}: ${hhmm(t)} ignores a buffer around the visit at ${hhmm(v.start)}-${hhmm(v.end)} (+${v.buffer})`).toBe(false);
      }
    }
    // diagnoseTime must agree exactly with what is offered, on and off the grid
    const probes = new Set<number>([...starts.slice(0, 2), ...starts.slice(-2)]);
    for (let m = OPEN - 20; m <= CLOSE + 10; m += 31) probes.add(m); // off-grid and in-the-buffer times as well as on-grid ones
    for (const v of visits) for (const m of [v.start - service.duration, v.end, v.end + 1]) probes.add(m); // edges of every booked visit
    for (const m of probes) {
      const verdict = await diagnoseTime(config, resourceId, service.id, new Date(at(m)), LONG_BEFORE);
      expect(verdict.available, `${where}: diagnoseTime says ${verdict.available ? "free" : "not free"} for ${hhmm(m)} but it is ${starts.includes(m) ? "offered" : "not offered"}`).toBe(starts.includes(m));
    }
  }
}

describe("slot offers stay consistent across services and buffers", () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7]) {
    it(`seed ${seed}: random bookings of mixed services never collide or break a buffer`, async () => {
      await pool.query("DELETE FROM appointments WHERE tenant_id = $1", [tenantId]);
      const rand = rng(seed * 7919);
      await checkInvariants(`seed ${seed}, empty day`);

      for (let i = 0; i < 5; i++) {
        const service = services[Math.floor(rand() * services.length)];
        const starts = await offered(service);
        if (starts.length === 0) break; // the day is full for this service
        const pick = starts[Math.floor(rand() * starts.length)];
        const config = await loadTenantConfigById(tenantId);
        // booking something the system offered must always succeed
        await booking.createAppointment(config, {
          serviceId: service.id, resourceId, startAt: new Date(at(pick)), patient: { name: `P${i}`, phone: `+9190000${String(i).padStart(5, "0")}` }, channel: "web",
        });
        await checkInvariants(`seed ${seed}, after booking ${i + 1} (${service.duration}+${service.buffer} at ${hhmm(pick)})`);
      }
    }, 120_000);
  }
});

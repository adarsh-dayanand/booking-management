// The public .ics endpoint over HTTP against the test database: a signed link serves the current booking; forged links,
// unknown appointments and cancelled bookings never leak anything.

import "dotenv/config";
import { randomUUID } from "crypto";
import type { AddressInfo } from "net";
import type { Server } from "http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
process.env.JWT_SECRET ||= "test-jwt-secret";
process.env.CRYPTO_KEY ||= Buffer.alloc(32, 7).toString("base64");

let pool: Pool;
let server: Server;
let base: string;
let tenantId: string;
let appointmentId: string;
let token: string;
let calendarToken: (id: string) => string;

beforeAll(async () => {
  const { default: express } = await import("express");
  const { AppError } = await import("../errors");
  const { calendarLinkRouter } = await import("../http/routes/calendarLink");
  ({ calendarToken } = await import("../calendar/addToCalendar"));
  ({ pool } = await import("../lib/db"));

  const app = express();
  app.use("/v1/public/calendar", calendarLinkRouter);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: unknown, res: any, _next: unknown) => res.status(err instanceof AppError ? err.statusCode : 500).json({ error: String(err) }));
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  tenantId = (await pool.query(`INSERT INTO tenants (name, slug, timezone, confirmation_policy) VALUES ('Cal Clinic', $1, 'Asia/Kolkata', 'instant') RETURNING id`, [`cal-${randomUUID()}`])).rows[0].id;
  const serviceId = (await pool.query(`INSERT INTO services (tenant_id, name, duration_minutes, buffer_minutes) VALUES ($1, 'Consult', 30, 0) RETURNING id`, [tenantId])).rows[0].id;
  const resourceId = (await pool.query(`INSERT INTO resources (tenant_id, name) VALUES ($1, 'Dr. Cal') RETURNING id`, [tenantId])).rows[0].id;
  const patientId = (await pool.query(`INSERT INTO patients (tenant_id, phone, phone_normalized, name) VALUES ($1, '+919000012345', '919000012345', 'Secret Sam') RETURNING id`, [tenantId])).rows[0].id;
  appointmentId = (await pool.query(
    `INSERT INTO appointments (tenant_id, patient_id, patient_name, service_id, resource_id, start_at, end_at, status, channel, idempotency_key)
     VALUES ($1, $2, 'Secret Sam', $3, $4, '2031-01-06T03:30:00Z', '2031-01-06T04:00:00Z', 'CONFIRMED', 'web', $5) RETURNING id`,
    [tenantId, patientId, serviceId, resourceId, randomUUID()]
  )).rows[0].id;
  token = calendarToken(appointmentId);
});

afterAll(async () => {
  for (const table of ["appointments", "patients", "services", "resources"]) await pool.query(`DELETE FROM ${table} WHERE tenant_id = $1`, [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  await pool.end();
  server.close();
});

describe("GET /v1/public/calendar/:token.ics", () => {
  it("serves the appointment as a calendar file, without the patient's details", async () => {
    const res = await fetch(`${base}/v1/public/calendar/${token}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/calendar");
    const body = await res.text();
    expect(body).toContain(`UID:${appointmentId}@booking-bot`);
    expect(body).toContain("SUMMARY:Consult with Dr. Cal");
    expect(body).toContain("DTSTART:20310106T033000Z");
    expect(body).toContain("LOCATION:Cal Clinic");
    expect(body).not.toContain("Sam");
    expect(body).not.toContain("9000012345");
  });

  it("rejects a forged or unsigned link", async () => {
    expect((await fetch(`${base}/v1/public/calendar/${appointmentId}.ics`)).status).toBe(404);
    expect((await fetch(`${base}/v1/public/calendar/${appointmentId}.badsignature.ics`)).status).toBe(404);
    expect((await fetch(`${base}/v1/public/calendar/${calendarToken(randomUUID())}.ics`)).status).toBe(404); // validly signed, no such appointment
  });

  it("reflects a reschedule (same UID, new time and sequence), and goes away once cancelled", async () => {
    await pool.query(`UPDATE appointments SET start_at = '2031-01-07T05:00:00Z', end_at = '2031-01-07T05:30:00Z', version = version + 1 WHERE id = $1`, [appointmentId]);
    const moved = await (await fetch(`${base}/v1/public/calendar/${token}.ics`)).text();
    expect(moved).toContain("DTSTART:20310107T050000Z");
    expect(moved).toContain(`UID:${appointmentId}@booking-bot`);
    expect(moved).toContain("SEQUENCE:2");

    await pool.query(`UPDATE appointments SET status = 'CANCELLED' WHERE id = $1`, [appointmentId]);
    expect((await fetch(`${base}/v1/public/calendar/${token}.ics`)).status).toBe(410);
  });
});

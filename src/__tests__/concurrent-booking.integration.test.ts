// Requires a real local Postgres test database with the schema applied:
//   createdb booking_management_bot_test
//   npm run db:setup:test
// Then: npm test
//
// This is the single most important test in the project: it proves BR-06
// (no double-booking) by firing two concurrent createAppointment() calls for
// the same resource/overlapping time and asserting the database's own
// exclusion constraint — not application code — lets exactly one through.

import "dotenv/config"; // must load before DATABASE_URL_TEST is read below
import { randomUUID } from "crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { TenantConfig } from "../types";

process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;

let pool: Pool;
let createAppointment: typeof import("../booking/booking").createAppointment;
let SlotConflictError: typeof import("../errors").SlotConflictError;

let tenantId: string;
let serviceId: string;
let resourceId: string;

function buildConfig(): TenantConfig {
  return {
    tenant: {
      id: tenantId,
      name: "Test Tenant",
      slug: "test-tenant",
      timezone: "UTC",
      confirmationPolicy: "staff_approval",
      whatsappPhoneNumberId: null,
      staffWhatsappNumber: null,
      reminderHoursBefore: 24,
      faqText: null,
    },
    services: [{ id: serviceId, tenantId, name: "Consult", durationMinutes: 30, bufferMinutes: 0, active: true }],
    resources: [
      {
        id: resourceId,
        tenantId,
        name: "Doc",
        googleCalendarId: null,
        googleRefreshTokenEncrypted: null,
        googleConnectionStatus: "disconnected", // no real Calendar call during this test
        active: true,
      },
    ],
    availabilityRules: [],
  };
}

beforeAll(async () => {
  ({ pool } = await import("../lib/db"));
  ({ createAppointment } = await import("../booking/booking"));
  ({ SlotConflictError } = await import("../errors"));

  const tenantResult = await pool.query(
    `INSERT INTO tenants (name, slug, timezone, confirmation_policy) VALUES ($1, $2, 'UTC', 'staff_approval') RETURNING id`,
    ["Test Tenant", `test-tenant-${randomUUID()}`]
  );
  tenantId = tenantResult.rows[0].id;

  const serviceResult = await pool.query(
    `INSERT INTO services (tenant_id, name, duration_minutes) VALUES ($1, 'Consult', 30) RETURNING id`,
    [tenantId]
  );
  serviceId = serviceResult.rows[0].id;

  const resourceResult = await pool.query(`INSERT INTO resources (tenant_id, name) VALUES ($1, 'Doc') RETURNING id`, [
    tenantId,
  ]);
  resourceId = resourceResult.rows[0].id;
});

afterAll(async () => {
  await pool.query("DELETE FROM appointments WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM patients WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM services WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM resources WHERE tenant_id = $1", [tenantId]);
  await pool.query("DELETE FROM tenants WHERE id = $1", [tenantId]);
  await pool.end();
});

describe("createAppointment concurrency", () => {
  it("lets exactly one of two overlapping concurrent bookings succeed (BR-06)", async () => {
    const config = buildConfig();
    const startAt = new Date("2030-01-01T10:00:00.000Z");

    const attempt = () =>
      createAppointment(config, {
        serviceId,
        resourceId,
        startAt,
        patient: { name: "Concurrent Patient", phone: "+10000000000" },
        channel: "web",
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(SlotConflictError);
  });
});

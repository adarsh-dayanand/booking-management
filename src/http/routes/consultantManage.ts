import bcrypt from "bcrypt";
import { Router } from "express";
import { DateTime } from "luxon";
import { z } from "zod";
import { pool } from "../../lib/db";
import { NotFoundError, ValidationError } from "../../errors";
import { generateAvailableSlots, onSlotGrid, openingWindowFor, slotStepMinutes } from "../../booking/booking";
import { loadTenantConfigById } from "../../booking/tenant";

// What a consultant (clinic) manages for itself from the dashboard: services, practitioners and their hours,
// the numbers on the home page, payment history and their own password. Mounted inside consultant.ts, i.e. behind
// requireAuth, and every query is scoped by the tenant id from the token — never from the URL.

export const consultantManageRouter = Router();

const zodMessage = (err: z.ZodError) => `${err.issues[0]?.path.join(".") || "request"}: ${err.issues[0]?.message}`;
const fail = (err: unknown) => (err instanceof z.ZodError ? new ValidationError(zodMessage(err)) : err);
const tenantOf = (req: { consultant?: { tenantId: string } }) => req.consultant!.tenantId;

// ---------------------------------------------------------------------------
// Services
// ---------------------------------------------------------------------------

const serviceView = (r: any) => ({ id: r.id, name: r.name, durationMinutes: r.duration_minutes, bufferMinutes: r.buffer_minutes, active: r.active });

const serviceFields = {
  name: z.string().trim().min(2).max(100),
  durationMinutes: z.number().int().min(5).max(480),
  bufferMinutes: z.number().int().min(0).max(120),
};

consultantManageRouter.get("/services", async (req, res, next) => {
  try {
    const r = await pool.query("SELECT * FROM services WHERE tenant_id = $1 ORDER BY active DESC, name ASC", [tenantOf(req)]);
    res.json({ services: r.rows.map(serviceView) });
  } catch (err) {
    next(err);
  }
});

consultantManageRouter.post("/services", async (req, res, next) => {
  try {
    const input = z.object({ ...serviceFields, bufferMinutes: serviceFields.bufferMinutes.default(0) }).parse(req.body ?? {});
    const r = await pool.query(
      "INSERT INTO services (tenant_id, name, duration_minutes, buffer_minutes) VALUES ($1, $2, $3, $4) RETURNING *",
      [tenantOf(req), input.name, input.durationMinutes, input.bufferMinutes]
    );
    res.status(201).json({ service: serviceView(r.rows[0]) });
  } catch (err) {
    next(fail(err));
  }
});

// Services are deactivated rather than deleted: past appointments still point at them.
consultantManageRouter.put("/services/:id", async (req, res, next) => {
  try {
    const patch = z.object({ ...serviceFields, active: z.boolean() }).partial().parse(req.body ?? {});
    const r = await pool.query(
      `UPDATE services SET name = COALESCE($3, name), duration_minutes = COALESCE($4, duration_minutes),
         buffer_minutes = COALESCE($5, buffer_minutes), active = COALESCE($6, active)
       WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [req.params.id, tenantOf(req), patch.name ?? null, patch.durationMinutes ?? null, patch.bufferMinutes ?? null, patch.active ?? null]
    );
    if (r.rowCount === 0) throw new NotFoundError("Service not found");
    res.json({ service: serviceView(r.rows[0]) });
  } catch (err) {
    next(fail(err));
  }
});

// ---------------------------------------------------------------------------
// Practitioners (resources) and their weekly hours
// ---------------------------------------------------------------------------

const resourceView = (r: any) => ({
  id: r.id, name: r.name, active: r.active, googleConnectionStatus: r.google_connection_status, googleCalendarId: r.google_calendar_id,
});

consultantManageRouter.get("/resources", async (req, res, next) => {
  try {
    const r = await pool.query("SELECT * FROM resources WHERE tenant_id = $1 ORDER BY active DESC, name ASC", [tenantOf(req)]);
    res.json({ resources: r.rows.map(resourceView) }); // never the stored (encrypted) Google token
  } catch (err) {
    next(err);
  }
});

consultantManageRouter.post("/resources", async (req, res, next) => {
  try {
    const { name } = z.object({ name: z.string().trim().min(2).max(100) }).parse(req.body ?? {});
    const r = await pool.query("INSERT INTO resources (tenant_id, name) VALUES ($1, $2) RETURNING *", [tenantOf(req), name]);
    res.status(201).json({ resource: resourceView(r.rows[0]) });
  } catch (err) {
    next(fail(err));
  }
});

consultantManageRouter.put("/resources/:id", async (req, res, next) => {
  try {
    const patch = z.object({ name: z.string().trim().min(2).max(100), active: z.boolean() }).partial().parse(req.body ?? {});
    const r = await pool.query(
      "UPDATE resources SET name = COALESCE($3, name), active = COALESCE($4, active) WHERE id = $1 AND tenant_id = $2 RETURNING *",
      [req.params.id, tenantOf(req), patch.name ?? null, patch.active ?? null]
    );
    if (r.rowCount === 0) throw new NotFoundError("Practitioner not found");
    res.json({ resource: resourceView(r.rows[0]) });
  } catch (err) {
    next(fail(err));
  }
});

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM (24h)");
const window_ = { start: hhmm, end: hhmm };
const ordered = (v: { start?: string; end?: string }) => !v.start || !v.end || v.start < v.end;

const availabilitySchema = z.object({
  // One opening window per weekday (0 = Sunday). A weekday that isn't listed is closed.
  weekly: z
    .array(z.object({ weekday: z.number().int().min(0).max(6), ...window_ }).refine(ordered, "end must be after start"))
    .refine((rows) => new Set(rows.map((r) => r.weekday)).size === rows.length, "each weekday may appear once"),
  // Date-specific overrides: closed for the day (holiday) or different hours.
  exceptions: z
    .array(
      z
        .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD"), closed: z.boolean(), start: hhmm.optional(), end: hhmm.optional() })
        .refine((e) => e.closed || (e.start && e.end), "open days need start and end")
        .refine(ordered, "end must be after start")
    )
    .refine((rows) => new Set(rows.map((r) => r.date)).size === rows.length, "each date may appear once"),
});

async function ownedResource(tenantId: string, id: string): Promise<void> {
  const r = await pool.query("SELECT 1 FROM resources WHERE id = $1 AND tenant_id = $2", [id, tenantId]);
  if (r.rowCount === 0) throw new NotFoundError("Practitioner not found");
}

consultantManageRouter.get("/resources/:id/availability", async (req, res, next) => {
  try {
    await ownedResource(tenantOf(req), req.params.id);
    const r = await pool.query(
      `SELECT weekday, to_char(specific_date, 'YYYY-MM-DD') AS date, to_char(start_time, 'HH24:MI') AS start,
              to_char(end_time, 'HH24:MI') AS "end", is_closed
       FROM availability_rules WHERE resource_id = $1 AND tenant_id = $2 ORDER BY weekday, specific_date`,
      [req.params.id, tenantOf(req)]
    );
    res.json({
      weekly: r.rows.filter((x) => x.weekday !== null && !x.is_closed).map((x) => ({ weekday: x.weekday, start: x.start, end: x.end })),
      exceptions: r.rows
        .filter((x) => x.date !== null)
        .map((x) => ({ date: x.date, closed: x.is_closed, ...(x.is_closed ? {} : { start: x.start, end: x.end }) })),
    });
  } catch (err) {
    next(err);
  }
});

// Replaces the practitioner's whole schedule atomically.
consultantManageRouter.put("/resources/:id/availability", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const input = availabilitySchema.parse(req.body ?? {});
    await ownedResource(tenantOf(req), req.params.id);
    await client.query("BEGIN");
    await client.query("DELETE FROM availability_rules WHERE resource_id = $1 AND tenant_id = $2", [req.params.id, tenantOf(req)]);
    for (const w of input.weekly) {
      await client.query(
        "INSERT INTO availability_rules (tenant_id, resource_id, weekday, start_time, end_time, is_closed) VALUES ($1, $2, $3, $4, $5, false)",
        [tenantOf(req), req.params.id, w.weekday, w.start, w.end]
      );
    }
    for (const e of input.exceptions) {
      await client.query(
        "INSERT INTO availability_rules (tenant_id, resource_id, specific_date, start_time, end_time, is_closed) VALUES ($1, $2, $3, $4, $5, $6)",
        [tenantOf(req), req.params.id, e.date, e.closed ? null : e.start, e.closed ? null : e.end, e.closed]
      );
    }
    await client.query("COMMIT");
    res.json(input);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    next(fail(err));
  } finally {
    client.release();
  }
});

// Free times for a service + practitioner — what the reschedule dialog offers (same engine the chat agent uses).
consultantManageRouter.get("/slots", async (req, res, next) => {
  try {
    const q = z
      .object({ serviceId: z.string().uuid(), resourceId: z.string().uuid(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), days: z.coerce.number().int().min(1).max(14).default(7) })
      .parse(req.query);
    const config = await loadTenantConfigById(tenantOf(req));
    const tz = config.tenant.timezone;
    const from = DateTime.fromISO(q.from, { zone: tz }).startOf("day");
    const slots = await generateAvailableSlots(config, q.resourceId, q.serviceId, new Date(Math.max(from.toMillis(), Date.now())), from.plus({ days: q.days }).toJSDate());
    res.json({ timezone: tz, slots: slots.map((s) => ({ ...s, local: DateTime.fromISO(s.startAt, { zone: "utc" }).setZone(tz).toFormat("ccc dd LLL, h:mm a") })) });
  } catch (err) {
    next(fail(err));
  }
});

// What the date-time picker shows under a chosen time: is it inside working hours, and does it collide with another
// booking? Advisory only — a consultant may deliberately book outside hours — but a collision is rejected on save
// (the database's no-overlap constraint), so the dialog uses it to stop the click early.
consultantManageRouter.get("/slots/check", async (req, res, next) => {
  try {
    const q = z
      .object({ serviceId: z.string().uuid(), resourceId: z.string().uuid(), startAt: z.string().datetime({ offset: true }), excludeAppointmentId: z.string().uuid().optional() })
      .parse(req.query);
    const config = await loadTenantConfigById(tenantOf(req));
    const service = config.services.find((s) => s.id === q.serviceId);
    const resource = config.resources.find((r) => r.id === q.resourceId);
    if (!service || !resource) throw new NotFoundError("Unknown service or practitioner");
    const start = new Date(q.startAt);
    const end = new Date(start.getTime() + service.durationMinutes * 60_000);
    const footprintEnd = new Date(end.getTime() + service.bufferMinutes * 60_000);
    // visits whose time — including their own service's buffer — touches the chosen time
    const near = await pool.query(
      `SELECT a.id, a.start_at, a.end_at, s.buffer_minutes, COALESCE(a.patient_name, p.name) AS patient_name
       FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN services s ON s.id = a.service_id
       WHERE a.tenant_id = $1 AND a.resource_id = $2 AND a.status IN ('AWAITING_PAYMENT', 'PENDING_CONFIRMATION', 'CONFIRMED')
         AND a.start_at < $4 AND a.end_at + make_interval(mins => s.buffer_minutes) > $3 AND ($5::uuid IS NULL OR a.id <> $5)
       ORDER BY a.start_at`,
      [tenantOf(req), q.resourceId, start, footprintEnd, q.excludeAppointmentId ?? null]
    );
    const view = (c: any) => ({ id: c.id, patientName: c.patient_name, startAt: c.start_at, endAt: c.end_at, bufferMinutes: c.buffer_minutes });
    const overlapping = near.rows.filter((c) => new Date(c.start_at) < end && new Date(c.end_at) > start);
    const tight = near.rows.filter((c) => !overlapping.includes(c));
    const hours = openingWindowFor(config, q.resourceId, service, start);
    res.json({
      startAt: start.toISOString(),
      endAt: end.toISOString(),
      inPast: start.getTime() < Date.now(),
      withinHours: hours.within,
      hours: hours.window,
      conflicts: overlapping.map(view),
      // not an overlap, but inside a clinic gap (the buffer after the previous visit, or before the next): a warning, never a block
      tight: tight.map(view),
      onGrid: onSlotGrid(config, q.resourceId, service, start),
      serviceStepMinutes: slotStepMinutes(service), // start times for this service come every this many minutes from opening
      serviceBufferMinutes: service.bufferMinutes, // the checked service's own turnover time (how much gap a visit of this service needs after it)
    });
  } catch (err) {
    next(fail(err));
  }
});

// ---------------------------------------------------------------------------
// Home-page numbers and payment history
// ---------------------------------------------------------------------------

consultantManageRouter.get("/overview", async (req, res, next) => {
  try {
    const tenantId = tenantOf(req);
    const tenant = (await pool.query("SELECT timezone, payments_enabled, collect_payments FROM tenants WHERE id = $1", [tenantId])).rows[0];
    const now = DateTime.now().setZone(tenant.timezone);
    const dayStart = now.startOf("day");
    const live = "a.status IN ('AWAITING_PAYMENT', 'PENDING_CONFIRMATION', 'CONFIRMED')";

    const [counts, next5, money] = await Promise.all([
      pool.query(
        `SELECT
           count(*) FILTER (WHERE ${live} AND a.start_at >= $2 AND a.start_at < $3)::int AS today,
           count(*) FILTER (WHERE ${live} AND a.start_at >= now() AND a.start_at < now() + interval '7 days')::int AS next_7_days,
           count(*) FILTER (WHERE a.status = 'PENDING_CONFIRMATION')::int AS pending_approval,
           count(*) FILTER (WHERE a.status = 'AWAITING_PAYMENT')::int AS awaiting_payment,
           count(*) FILTER (WHERE a.calendar_sync_status = 'failed' AND ${live})::int AS sync_failed,
           (SELECT count(*)::int FROM patients p WHERE p.tenant_id = $1) AS users,
           (SELECT count(*)::int FROM patients p WHERE p.tenant_id = $1 AND p.first_seen_at > now() - interval '30 days') AS new_users_30d
         FROM appointments a WHERE a.tenant_id = $1`,
        [tenantId, dayStart.toJSDate(), dayStart.plus({ days: 1 }).toJSDate()]
      ),
      pool.query(
        `SELECT a.id, a.status, a.start_at, COALESCE(a.patient_name, p.name) AS patient_name, s.name AS service_name, r.name AS resource_name
         FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN services s ON s.id = a.service_id JOIN resources r ON r.id = a.resource_id
         WHERE a.tenant_id = $1 AND ${live} AND a.end_at > now() ORDER BY a.start_at ASC LIMIT 5`,
        [tenantId]
      ),
      pool.query(
        `SELECT COALESCE(sum(amount_paise) FILTER (WHERE paid_at >= $2), 0)::bigint AS today,
                COALESCE(sum(amount_paise) FILTER (WHERE paid_at > now() - interval '30 days'), 0)::bigint AS last_30_days,
                count(*) FILTER (WHERE paid_at > now() - interval '30 days')::int AS paid_count_30d
         FROM payments WHERE tenant_id = $1 AND status = 'paid'`,
        [tenantId, dayStart.toJSDate()]
      ),
    ]);
    const c = counts.rows[0];
    res.json({
      timezone: tenant.timezone,
      paymentsActive: tenant.payments_enabled && tenant.collect_payments,
      today: c.today,
      next7Days: c.next_7_days,
      pendingApproval: c.pending_approval,
      awaitingPayment: c.awaiting_payment,
      syncFailed: c.sync_failed,
      users: c.users,
      newUsers30d: c.new_users_30d,
      revenue: { todayPaise: Number(money.rows[0].today), last30DaysPaise: Number(money.rows[0].last_30_days), paidCount30d: money.rows[0].paid_count_30d },
      upcoming: next5.rows,
    });
  } catch (err) {
    next(err);
  }
});

consultantManageRouter.get("/payments/transactions", async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const r = await pool.query(
      `SELECT pay.id, pay.status, pay.amount_paise, pay.band, pay.created_at, pay.paid_at, pay.razorpay_payment_id,
              a.id AS appointment_id, a.start_at, COALESCE(a.patient_name, p.name) AS patient_name, p.phone AS patient_phone, s.name AS service_name
       FROM payments pay JOIN appointments a ON a.id = pay.appointment_id JOIN patients p ON p.id = a.patient_id JOIN services s ON s.id = a.service_id
       WHERE pay.tenant_id = $1 ORDER BY pay.created_at DESC LIMIT $2`,
      [tenantOf(req), limit]
    );
    res.json({ transactions: r.rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

consultantManageRouter.post("/account/password", async (req, res, next) => {
  try {
    const input = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(8, "password must be at least 8 characters").max(200) }).parse(req.body ?? {});
    const user = (await pool.query("SELECT password_hash FROM staff_users WHERE id = $1 AND tenant_id = $2", [req.consultant!.consultantUserId, tenantOf(req)])).rows[0];
    if (!user || !(await bcrypt.compare(input.currentPassword, user.password_hash))) // 400, not 401: the dashboard treats a 401 as "session expired" and would log the user out over a typo.
    throw new ValidationError("Current password is incorrect");
    await pool.query("UPDATE staff_users SET password_hash = $2 WHERE id = $1", [req.consultant!.consultantUserId, await bcrypt.hash(input.newPassword, 10)]);
    res.json({ ok: true });
  } catch (err) {
    next(fail(err));
  }
});

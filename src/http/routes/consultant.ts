import { Router } from "express";
import { DateTime } from "luxon";
import { z } from "zod";
import { login, requireAuth } from "../auth";
import * as booking from "../../booking/booking";
import { pool } from "../../lib/db";
import { ValidationError, NotFoundError } from "../../errors";
import { isGoogleConfigured } from "../../config";
import { createConnectLink } from "../../calendar/googleCalendar";
import { digitsOnly } from "../../lib/phone";
import { searchPatients, mapPatient } from "../../booking/patients";
import { rateLimit } from "../../lib/rateLimit";
import { isPgError } from "../../lib/db";
import { loadTenantConfigById } from "../../booking/tenant";
import { consultantPaymentsRouter } from "./consultantPayments";
import { consultantManageRouter } from "./consultantManage";
import { consultantWhatsappRouter } from "./consultantWhatsapp";

export const consultantRouter = Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

consultantRouter.post("/login", rateLimit("login", 10, 15 * 60_000), async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const token = await login(email, password);
    res.json({ token });
  } catch (err) {
    next(err instanceof z.ZodError ? new ValidationError(err.issues[0]?.message) : err);
  }
});

consultantRouter.use(requireAuth);

// Everything below is tenant-scoped from the JWT claim, never from the URL —
// staff can't even address another clinic's data by changing a path segment.

consultantRouter.use("/payments", consultantPaymentsRouter);
consultantRouter.use(consultantManageRouter);
consultantRouter.use("/whatsapp", consultantWhatsappRouter);

consultantRouter.get("/appointments", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const result = await pool.query(
      `SELECT a.*, COALESCE(a.patient_name, p.name) AS patient_name, p.phone AS patient_phone, s.name AS service_name, r.name AS resource_name,
              pay.status AS payment_status, pay.amount_paise
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       JOIN services s ON s.id = a.service_id
       JOIN resources r ON r.id = a.resource_id
       LEFT JOIN payments pay ON pay.appointment_id = a.id
       WHERE a.tenant_id = $1 AND ($2::text IS NULL OR a.status = $2)
       ORDER BY a.start_at ASC LIMIT 1000`,
      [req.consultant!.tenantId, status ?? null]
    );
    res.json({ appointments: result.rows });
  } catch (err) {
    next(err);
  }
});

consultantRouter.post("/appointments/:id/approve", async (req, res, next) => {
  try {
    const config = await loadTenantConfigById(req.consultant!.tenantId);
    const appointment = await booking.approveAppointment(config, req.params.id);
    res.json({ appointment });
  } catch (err) {
    next(err);
  }
});

consultantRouter.post("/appointments/:id/reject", async (req, res, next) => {
  try {
    const config = await loadTenantConfigById(req.consultant!.tenantId);
    const appointment = await booking.rejectAppointment(config, req.params.id, req.body?.reason);
    res.json({ appointment });
  } catch (err) {
    next(err);
  }
});

consultantRouter.post("/appointments/:id/cancel", async (req, res, next) => {
  try {
    const config = await loadTenantConfigById(req.consultant!.tenantId);
    const appointment = await booking.cancelAppointment(config, req.params.id, req.body?.reason);
    res.json({ appointment });
  } catch (err) {
    next(err);
  }
});

const rescheduleSchema = z.object({ startAt: z.string().datetime() });

consultantRouter.post("/appointments/:id/reschedule", async (req, res, next) => {
  try {
    const { startAt } = rescheduleSchema.parse(req.body);
    const config = await loadTenantConfigById(req.consultant!.tenantId);
    const appointment = await booking.rescheduleAppointment(config, req.params.id, new Date(startAt));
    res.json({ appointment });
  } catch (err) {
    next(err instanceof z.ZodError ? new ValidationError(err.issues[0]?.message) : err);
  }
});

consultantRouter.post("/appointments/:id/retry-sync", async (req, res, next) => {
  try {
    const config = await loadTenantConfigById(req.consultant!.tenantId);
    const appointment = await booking.retrySync(config, req.params.id);
    res.json({ appointment });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Clinic settings — where the admin picks the booking flow and notification details.
//   confirmationPolicy "instant":        direct booking — free calendar time is offered, booking confirms + blocks the calendar
//   confirmationPolicy "staff_approval": the doctor must explicitly accept (APPROVE <ref> on WhatsApp, or the dashboard)
// ---------------------------------------------------------------------------

function settingsView(t: any) {
  return {
    name: t.name,
    timezone: t.timezone,
    confirmationPolicy: t.confirmation_policy,
    staffWhatsappNumber: t.staff_whatsapp_number,
    reminderHoursBefore: t.reminder_hours_before,
    slotIntervalMinutes: t.slot_interval_minutes,
    faqText: t.faq_text,
    whatsappPhoneNumberId: t.whatsapp_phone_number_id,
  };
}

consultantRouter.get("/settings", async (req, res, next) => {
  try {
    const result = await pool.query("SELECT * FROM tenants WHERE id = $1", [req.consultant!.tenantId]);
    res.json({ settings: settingsView(result.rows[0]) });
  } catch (err) {
    next(err);
  }
});

const settingsSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    timezone: z.string().refine((tz) => DateTime.local().setZone(tz).isValid, "not a valid IANA timezone (e.g. Asia/Kolkata)"),
    confirmationPolicy: z.enum(["instant", "staff_approval"]),
    staffWhatsappNumber: z.string().nullable().transform((v) => (v ? digitsOnly(v) : null)).refine((v) => v === null || (v.length >= 8 && v.length <= 15), "staffWhatsappNumber must be 8-15 digits including country code"),
    reminderHoursBefore: z.number().int().min(0).max(168),
    slotIntervalMinutes: z.number().int().min(5, "slot interval must be at least 5 minutes").max(240),
    faqText: z.string().max(4000).nullable(),
  })
  .partial()
  .strict(); // the WhatsApp number is connected on the WhatsApp page (or set by the admin), never typed in here

consultantRouter.put("/settings", async (req, res, next) => {
  try {
    const patch = settingsSchema.parse(req.body ?? {});
    const columns: Record<string, string> = {
      name: "name",
      timezone: "timezone",
      confirmationPolicy: "confirmation_policy",
      staffWhatsappNumber: "staff_whatsapp_number",
      reminderHoursBefore: "reminder_hours_before",
      slotIntervalMinutes: "slot_interval_minutes",
      faqText: "faq_text",
    };
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) throw new ValidationError("No settings provided");

    const sets = entries.map(([k], i) => `${columns[k]} = $${i + 2}`).join(", ");
    const result = await pool.query(`UPDATE tenants SET ${sets} WHERE id = $1 RETURNING *`, [
      req.consultant!.tenantId,
      ...entries.map(([, v]) => v),
    ]);
    const settings = settingsView(result.rows[0]);
    const warnings: string[] = [];
    if (settings.confirmationPolicy === "staff_approval" && !settings.staffWhatsappNumber) {
      warnings.push("staff_approval is on but staffWhatsappNumber is not set: the doctor won't get WhatsApp approval requests (the dashboard still works).");
    }
    if (!settings.whatsappPhoneNumberId) warnings.push("No WhatsApp number is connected: no WhatsApp messages can be received or sent for this clinic. Connect one on the WhatsApp page.");
    res.json({ settings, warnings });
  } catch (err) {
    next(err instanceof z.ZodError ? new ValidationError(err.issues[0]?.message) : err);
  }
});

// Link a doctor can open to connect their Google Calendar (valid 20 minutes, only for this resource).
consultantRouter.get("/resources/:id/connect-link", async (req, res, next) => {
  try {
    if (!isGoogleConfigured) throw new ValidationError("Google Calendar is not configured on the server");
    const result = await pool.query("SELECT id FROM resources WHERE id = $1 AND tenant_id = $2", [req.params.id, req.consultant!.tenantId]);
    if (result.rowCount === 0) throw new NotFoundError("Resource not found");
    res.json({ url: createConnectLink(req.params.id, req.consultant!.tenantId), expiresInMinutes: 20 });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Users (the end users who chat/book) — profiles are created automatically from a person's first message (no registration step).
// ---------------------------------------------------------------------------

consultantRouter.get("/users", async (req, res, next) => {
  try {
    const phone = typeof req.query.phone === "string" ? req.query.phone : undefined;
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    if (limit !== undefined && !(limit > 0)) throw new ValidationError("limit must be a positive number");
    res.json({ users: await searchPatients(req.consultant!.tenantId, { phone, q, limit }) });
  } catch (err) {
    next(err);
  }
});

consultantRouter.get("/users/:id", async (req, res, next) => {
  try {
    const found = await pool.query("SELECT * FROM patients WHERE id = $1 AND tenant_id = $2", [req.params.id, req.consultant!.tenantId]);
    if (found.rowCount === 0) throw new NotFoundError("User not found");
    const appointments = await pool.query(
      `SELECT a.id, a.status, a.start_at, a.end_at, a.channel, COALESCE(a.patient_name, p.name) AS patient_name,
              s.name AS service_name, r.name AS resource_name
       FROM appointments a JOIN patients p ON p.id = a.patient_id
       JOIN services s ON s.id = a.service_id JOIN resources r ON r.id = a.resource_id
       WHERE a.patient_id = $1 ORDER BY a.start_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({ user: mapPatient(found.rows[0]), appointments: appointments.rows });
  } catch (err) {
    next(err);
  }
});

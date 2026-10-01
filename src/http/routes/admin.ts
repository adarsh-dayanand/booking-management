import { Router } from "express";
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

export const adminRouter = Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

adminRouter.post("/login", rateLimit("login", 10, 15 * 60_000), async (req, res, next) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    const token = await login(email, password);
    res.json({ token });
  } catch (err) {
    next(err instanceof z.ZodError ? new ValidationError(err.issues[0]?.message) : err);
  }
});

adminRouter.use(requireAuth);

// Everything below is tenant-scoped from the JWT claim, never from the URL —
// staff can't even address another clinic's data by changing a path segment.

adminRouter.get("/appointments", async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    const result = await pool.query(
      `SELECT a.*, COALESCE(a.patient_name, p.name) AS patient_name, p.phone AS patient_phone, s.name AS service_name, r.name AS resource_name
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       JOIN services s ON s.id = a.service_id
       JOIN resources r ON r.id = a.resource_id
       WHERE a.tenant_id = $1 AND ($2::text IS NULL OR a.status = $2)
       ORDER BY a.start_at ASC`,
      [req.staff!.tenantId, status ?? null]
    );
    res.json({ appointments: result.rows });
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/resources", async (req, res, next) => {
  try {
    const config = await loadTenantConfigById(req.staff!.tenantId);
    res.json({
      // never expose the stored (encrypted) Google refresh token
      resources: config.resources.map(({ googleRefreshTokenEncrypted: _token, ...safe }) => safe),
    });
  } catch (err) {
    next(err);
  }
});

adminRouter.post("/appointments/:id/approve", async (req, res, next) => {
  try {
    const config = await loadTenantConfigById(req.staff!.tenantId);
    const appointment = await booking.approveAppointment(config, req.params.id);
    res.json({ appointment });
  } catch (err) {
    next(err);
  }
});

adminRouter.post("/appointments/:id/reject", async (req, res, next) => {
  try {
    const config = await loadTenantConfigById(req.staff!.tenantId);
    const appointment = await booking.rejectAppointment(config, req.params.id, req.body?.reason);
    res.json({ appointment });
  } catch (err) {
    next(err);
  }
});

adminRouter.post("/appointments/:id/cancel", async (req, res, next) => {
  try {
    const config = await loadTenantConfigById(req.staff!.tenantId);
    const appointment = await booking.cancelAppointment(config, req.params.id, req.body?.reason);
    res.json({ appointment });
  } catch (err) {
    next(err);
  }
});

const rescheduleSchema = z.object({ startAt: z.string().datetime() });

adminRouter.post("/appointments/:id/reschedule", async (req, res, next) => {
  try {
    const { startAt } = rescheduleSchema.parse(req.body);
    const config = await loadTenantConfigById(req.staff!.tenantId);
    const appointment = await booking.rescheduleAppointment(config, req.params.id, new Date(startAt));
    res.json({ appointment });
  } catch (err) {
    next(err instanceof z.ZodError ? new ValidationError(err.issues[0]?.message) : err);
  }
});

adminRouter.post("/appointments/:id/retry-sync", async (req, res, next) => {
  try {
    const config = await loadTenantConfigById(req.staff!.tenantId);
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
    faqText: t.faq_text,
    whatsappPhoneNumberId: t.whatsapp_phone_number_id,
  };
}

adminRouter.get("/settings", async (req, res, next) => {
  try {
    const result = await pool.query("SELECT * FROM tenants WHERE id = $1", [req.staff!.tenantId]);
    res.json({ settings: settingsView(result.rows[0]) });
  } catch (err) {
    next(err);
  }
});

const settingsSchema = z
  .object({
    confirmationPolicy: z.enum(["instant", "staff_approval"]),
    staffWhatsappNumber: z.string().nullable().transform((v) => (v ? digitsOnly(v) : null)).refine((v) => v === null || (v.length >= 8 && v.length <= 15), "staffWhatsappNumber must be 8-15 digits including country code"),
    reminderHoursBefore: z.number().int().min(0).max(168),
    faqText: z.string().max(4000).nullable(),
    whatsappPhoneNumberId: z.string().min(1).max(64).nullable(),
  })
  .partial();

adminRouter.put("/settings", async (req, res, next) => {
  try {
    const patch = settingsSchema.parse(req.body ?? {});
    const columns: Record<string, string> = {
      confirmationPolicy: "confirmation_policy",
      staffWhatsappNumber: "staff_whatsapp_number",
      reminderHoursBefore: "reminder_hours_before",
      faqText: "faq_text",
      whatsappPhoneNumberId: "whatsapp_phone_number_id",
    };
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) throw new ValidationError("No settings provided");

    const sets = entries.map(([k], i) => `${columns[k]} = $${i + 2}`).join(", ");
    const result = await pool.query(`UPDATE tenants SET ${sets} WHERE id = $1 RETURNING *`, [
      req.staff!.tenantId,
      ...entries.map(([, v]) => v),
    ]);
    const settings = settingsView(result.rows[0]);
    const warnings: string[] = [];
    if (settings.confirmationPolicy === "staff_approval" && !settings.staffWhatsappNumber) {
      warnings.push("staff_approval is on but staffWhatsappNumber is not set: the doctor won't get WhatsApp approval requests (the dashboard still works).");
    }
    if (!settings.whatsappPhoneNumberId) warnings.push("whatsappPhoneNumberId is not set: no WhatsApp messages can be received or sent for this clinic.");
    res.json({ settings, warnings });
  } catch (err) {
    if (isPgError(err, "23505")) return next(new ValidationError("That WhatsApp phone number id is already used by another clinic"));
    next(err instanceof z.ZodError ? new ValidationError(err.issues[0]?.message) : err);
  }
});

// Link a doctor can open to connect their Google Calendar (valid 20 minutes, only for this resource).
adminRouter.get("/resources/:id/connect-link", async (req, res, next) => {
  try {
    if (!isGoogleConfigured) throw new ValidationError("Google Calendar is not configured on the server");
    const result = await pool.query("SELECT id FROM resources WHERE id = $1 AND tenant_id = $2", [req.params.id, req.staff!.tenantId]);
    if (result.rowCount === 0) throw new NotFoundError("Resource not found");
    res.json({ url: createConnectLink(req.params.id, req.staff!.tenantId), expiresInMinutes: 20 });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Patients — profiles are created automatically from a person's first message (no registration step).
// ---------------------------------------------------------------------------

adminRouter.get("/patients", async (req, res, next) => {
  try {
    const phone = typeof req.query.phone === "string" ? req.query.phone : undefined;
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    if (limit !== undefined && !(limit > 0)) throw new ValidationError("limit must be a positive number");
    res.json({ patients: await searchPatients(req.staff!.tenantId, { phone, q, limit }) });
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/patients/:id", async (req, res, next) => {
  try {
    const found = await pool.query("SELECT * FROM patients WHERE id = $1 AND tenant_id = $2", [req.params.id, req.staff!.tenantId]);
    if (found.rowCount === 0) throw new NotFoundError("Patient not found");
    const appointments = await pool.query(
      `SELECT a.id, a.status, a.start_at, a.end_at, a.channel, COALESCE(a.patient_name, p.name) AS patient_name,
              s.name AS service_name, r.name AS resource_name
       FROM appointments a JOIN patients p ON p.id = a.patient_id
       JOIN services s ON s.id = a.service_id JOIN resources r ON r.id = a.resource_id
       WHERE a.patient_id = $1 ORDER BY a.start_at DESC LIMIT 50`,
      [req.params.id]
    );
    res.json({ patient: mapPatient(found.rows[0]), appointments: appointments.rows });
  } catch (err) {
    next(err);
  }
});

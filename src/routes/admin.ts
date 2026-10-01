import { Router } from "express";
import { z } from "zod";
import { login, requireAuth } from "../auth";
import * as booking from "../booking";
import { pool } from "../db";
import { ValidationError } from "../errors";
import { loadTenantConfigById } from "../tenant";

export const adminRouter = Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

adminRouter.post("/login", async (req, res, next) => {
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
      `SELECT a.*, p.name AS patient_name, p.phone AS patient_phone, s.name AS service_name, r.name AS resource_name
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
    res.json({ resources: config.resources });
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

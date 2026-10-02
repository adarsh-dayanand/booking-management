import { Router } from "express";
import { z } from "zod";
import { pool } from "../../lib/db";
import { ForbiddenError, NotFoundError, ValidationError } from "../../errors";
import { loadTenantConfigById } from "../../booking/tenant";
import { formatRupees, pricingSchema, quoteFee } from "../../payments/pricing";

// Consultant-side payment settings: how much to charge and whether to charge. Mounted under /v1/consultant/payments
// (already behind requireAuth). Whether payments are *available* is the admin's decision.

export const consultantPaymentsRouter = Router();

function view(t: any) {
  return {
    available: t.payments_enabled,
    collectPayments: t.payments_enabled && t.collect_payments,
    currency: "INR",
    pricing: t.consultation_pricing,
    note: t.payments_enabled
      ? undefined
      : "Online payments aren't enabled for this consultant. Ask the admin to connect Razorpay.",
  };
}

async function loadTenantRow(tenantId: string) {
  return (await pool.query("SELECT * FROM tenants WHERE id = $1", [tenantId])).rows[0];
}

consultantPaymentsRouter.get("/", async (req, res, next) => {
  try {
    res.json({ payments: view(await loadTenantRow(req.consultant!.tenantId)) });
  } catch (err) {
    next(err);
  }
});

const settingsSchema = z.object({ collectPayments: z.boolean(), pricing: pricingSchema }).partial();

consultantPaymentsRouter.put("/", async (req, res, next) => {
  try {
    const patch = settingsSchema.parse(req.body ?? {});
    const tenant = await loadTenantRow(req.consultant!.tenantId);
    if (!tenant.payments_enabled) {
      throw new ForbiddenError("Online payments aren't enabled for this consultant. Ask the admin to connect Razorpay.");
    }
    const pricing = patch.pricing ?? tenant.consultation_pricing;
    const collect = patch.collectPayments ?? tenant.collect_payments;
    if (collect && !pricing) throw new ValidationError("Set your consultation fees before turning payments on");

    const result = await pool.query(
      "UPDATE tenants SET collect_payments = $2, consultation_pricing = $3 WHERE id = $1 RETURNING *",
      [tenant.id, collect, pricing ? JSON.stringify(pricing) : null]
    );
    res.json({ payments: view(result.rows[0]) });
  } catch (err) {
    next(err instanceof z.ZodError ? new ValidationError(`${err.issues[0]?.path.join(".")}: ${err.issues[0]?.message}`) : err);
  }
});

// What would a patient be charged for this service at this time? Handy for checking the weekend/night bands.
consultantPaymentsRouter.get("/quote", async (req, res, next) => {
  try {
    const { serviceId, startAt } = z.object({ serviceId: z.string().uuid(), startAt: z.string().datetime({ offset: true }) }).parse(req.query);
    const config = await loadTenantConfigById(req.consultant!.tenantId);
    const service = config.services.find((s) => s.id === serviceId);
    if (!service) throw new NotFoundError("Unknown service");
    if (!config.tenant.pricing) throw new ValidationError("No consultation fees set yet");
    const quote = quoteFee(config.tenant.pricing, config.tenant.timezone, new Date(startAt), service);
    res.json({ ...quote, amount: formatRupees(quote.amountPaise), currency: "INR", durationMinutes: service.durationMinutes });
  } catch (err) {
    next(err instanceof z.ZodError ? new ValidationError(`${err.issues[0]?.path.join(".")}: ${err.issues[0]?.message}`) : err);
  }
});

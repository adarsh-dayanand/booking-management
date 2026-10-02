import { createHash, timingSafeEqual } from "crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../../config";
import { pool } from "../../lib/db";
import { decrypt, encrypt } from "../../lib/crypto";
import { ForbiddenError, NotFoundError, UnauthorizedError, ValidationError } from "../../errors";
import { rateLimit } from "../../lib/rateLimit";
import { verifyCredentials, RazorpayError } from "../../payments/razorpay";

// The ADMIN API: the platform operator, not a consultant (clinic) and not an end user. A consultant can only take payments
// after the admin has stored its Razorpay credentials here and switched payments on; consultants cannot do either
// (they set fees in routes/consultantPayments.ts).

export const adminRouter = Router();

const digest = (v: string) => createHash("sha256").update(v).digest();

function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!config.adminToken) return next(new ForbiddenError("The admin API is disabled (set ADMIN_TOKEN)"));
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  // Hash both sides so the comparison is constant-time regardless of length.
  if (!token || !timingSafeEqual(digest(token), digest(config.adminToken))) return next(new UnauthorizedError("Invalid admin token"));
  next();
}

adminRouter.use(rateLimit("admin", 60, 15 * 60_000), requireAdmin);

function paymentsView(t: any) {
  return {
    slug: t.slug,
    name: t.name,
    paymentsEnabled: t.payments_enabled,
    razorpayKeyId: t.razorpay_key_id,
    razorpayMode: t.razorpay_key_id ? (String(t.razorpay_key_id).startsWith("rzp_live_") ? "live" : "test") : null,
    keySecretConfigured: Boolean(t.razorpay_key_secret_encrypted),
    webhookSecretConfigured: Boolean(t.razorpay_webhook_secret_encrypted),
    consultantCollectsPayments: t.collect_payments,
    consultationPricing: t.consultation_pricing,
    // Register this URL in the consultant's Razorpay dashboard (Settings → Webhooks) with the payment_link.paid event.
    webhookUrl: `${config.baseUrl}/v1/webhooks/razorpay/${t.slug}`,
  };
}

async function findTenant(slug: string) {
  const result = await pool.query("SELECT * FROM tenants WHERE slug = $1", [slug]);
  if (result.rowCount === 0) throw new NotFoundError(`Unknown consultant: ${slug}`);
  return result.rows[0];
}

adminRouter.get("/tenants", async (_req, res, next) => {
  try {
    const result = await pool.query("SELECT * FROM tenants ORDER BY created_at ASC");
    res.json({ tenants: result.rows.map(paymentsView) });
  } catch (err) {
    next(err);
  }
});

adminRouter.get("/tenants/:slug/payments", async (req, res, next) => {
  try {
    res.json({ payments: paymentsView(await findTenant(req.params.slug)) });
  } catch (err) {
    next(err);
  }
});

const paymentsSchema = z
  .object({
    enabled: z.boolean(),
    razorpayKeyId: z.string().trim().regex(/^rzp_(test|live)_[A-Za-z0-9]+$/, "expected a Razorpay key id like rzp_test_xxxxxxxx"),
    razorpayKeySecret: z.string().trim().min(8).max(200),
    razorpayWebhookSecret: z.string().trim().min(8).max(200),
  })
  .partial();

// Omitted fields keep their stored value, so enabling/disabling never requires re-sending secrets.
adminRouter.put("/tenants/:slug/payments", async (req, res, next) => {
  try {
    const patch = paymentsSchema.parse(req.body ?? {});
    const tenant = await findTenant(req.params.slug);

    const keyId: string | null = patch.razorpayKeyId ?? tenant.razorpay_key_id;
    const keySecret: string | null = patch.razorpayKeySecret ?? (tenant.razorpay_key_secret_encrypted ? decrypt(tenant.razorpay_key_secret_encrypted) : null);
    const webhookSecret: string | null = patch.razorpayWebhookSecret ?? (tenant.razorpay_webhook_secret_encrypted ? decrypt(tenant.razorpay_webhook_secret_encrypted) : null);
    const enabled = patch.enabled ?? tenant.payments_enabled;

    if (enabled && (!keyId || !keySecret || !webhookSecret)) {
      throw new ValidationError("Enabling payments needs razorpayKeyId, razorpayKeySecret and razorpayWebhookSecret");
    }
    if (keyId && keySecret && (patch.razorpayKeyId || patch.razorpayKeySecret)) {
      try {
        await verifyCredentials({ keyId, keySecret });
      } catch (err) {
        if (err instanceof RazorpayError && err.status === undefined) throw new ValidationError(`Couldn't verify the credentials: ${err.message}`);
        throw new ValidationError("Razorpay rejected these credentials. Check the key id and secret.");
      }
    }

    const result = await pool.query(
      `UPDATE tenants SET payments_enabled = $2, razorpay_key_id = $3, razorpay_key_secret_encrypted = $4, razorpay_webhook_secret_encrypted = $5
       WHERE id = $1 RETURNING *`,
      [tenant.id, enabled, keyId, keySecret ? encrypt(keySecret) : null, webhookSecret ? encrypt(webhookSecret) : null]
    );
    res.json({ payments: paymentsView(result.rows[0]) });
  } catch (err) {
    next(err instanceof z.ZodError ? new ValidationError(`${err.issues[0]?.path.join(".")}: ${err.issues[0]?.message}`) : err);
  }
});

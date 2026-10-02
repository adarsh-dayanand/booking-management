import { createHash, timingSafeEqual } from "crypto";
import bcrypt from "bcrypt";
import { DateTime } from "luxon";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { config } from "../../config";
import { isPgError, pool } from "../../lib/db";
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

/** Everything the admin sees about a consultant: identity, flow, payments setup and how much it is used. */
function consultantView(t: any) {
  return {
    ...paymentsView(t),
    timezone: t.timezone,
    confirmationPolicy: t.confirmation_policy,
    whatsappPhoneNumberId: t.whatsapp_phone_number_id,
    createdAt: t.created_at,
    counts: t.counts,
  };
}

const withCounts = `SELECT t.*, json_build_object(
    'appointments', (SELECT count(*)::int FROM appointments a WHERE a.tenant_id = t.id),
    'users', (SELECT count(*)::int FROM patients p WHERE p.tenant_id = t.id),
    'logins', (SELECT count(*)::int FROM staff_users u WHERE u.tenant_id = t.id)
  ) AS counts FROM tenants t`;

const zodMessage = (err: z.ZodError) => `${err.issues[0]?.path.join(".") || "request"}: ${err.issues[0]?.message}`;
const fail = (err: unknown) => (err instanceof z.ZodError ? new ValidationError(zodMessage(err)) : err);

adminRouter.get("/tenants", async (_req, res, next) => {
  try {
    const result = await pool.query(`${withCounts} ORDER BY t.created_at ASC`);
    res.json({ tenants: result.rows.map(consultantView) });
  } catch (err) {
    next(err);
  }
});

// Cheap authenticated read the admin app uses to check a pasted token, and its home-page numbers.
adminRouter.get("/overview", async (_req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM tenants) AS consultants,
         (SELECT count(*)::int FROM tenants WHERE payments_enabled) AS payments_enabled,
         (SELECT count(*)::int FROM appointments WHERE created_at > now() - interval '30 days') AS appointments_30d,
         (SELECT count(*)::int FROM patients) AS users,
         (SELECT COALESCE(sum(amount_paise), 0)::bigint FROM payments WHERE status = 'paid' AND paid_at > now() - interval '30 days') AS revenue_30d_paise`
    );
    const r = result.rows[0];
    res.json({
      consultants: r.consultants,
      paymentsEnabled: r.payments_enabled,
      appointments30d: r.appointments_30d,
      users: r.users,
      revenue30dPaise: Number(r.revenue_30d_paise),
    });
  } catch (err) {
    next(err);
  }
});

const timezone = z.string().refine((tz) => DateTime.local().setZone(tz).isValid, "not a valid IANA timezone (e.g. Asia/Kolkata)");
const email = z.string().trim().toLowerCase().email().max(200);
const password = z.string().min(8, "password must be at least 8 characters").max(200);

async function emailTaken(address: string, exceptId?: string): Promise<boolean> {
  // Login looks a person up by email alone, so an address may belong to only one consultant.
  const r = await pool.query("SELECT 1 FROM staff_users WHERE lower(email) = $1 AND ($2::uuid IS NULL OR id <> $2)", [address, exceptId ?? null]);
  return (r.rowCount ?? 0) > 0;
}

const createSchema = z.object({
  name: z.string().trim().min(2).max(100),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "use lowercase letters, numbers and dashes").min(3).max(40),
  timezone,
  confirmationPolicy: z.enum(["instant", "staff_approval"]).default("staff_approval"),
  whatsappPhoneNumberId: z.string().trim().min(1).max(64).nullable().optional(),
  owner: z.object({ email, password }),
});

// Onboard a consultant: the clinic itself plus the first login its team uses at /consultant/.
adminRouter.post("/tenants", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const input = createSchema.parse(req.body ?? {});
    if (await emailTaken(input.owner.email)) throw new ValidationError("That email is already used by another consultant login");
    await client.query("BEGIN");
    const tenant = await client.query(
      `INSERT INTO tenants (name, slug, timezone, confirmation_policy, whatsapp_phone_number_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.name, input.slug, input.timezone, input.confirmationPolicy, input.whatsappPhoneNumberId ?? null]
    );
    await client.query("INSERT INTO staff_users (tenant_id, email, password_hash) VALUES ($1, $2, $3)", [
      tenant.rows[0].id, input.owner.email, await bcrypt.hash(input.owner.password, 10),
    ]);
    await client.query("COMMIT");
    const created = await pool.query(`${withCounts} WHERE t.id = $1`, [tenant.rows[0].id]);
    res.status(201).json({ consultant: consultantView(created.rows[0]) });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (isPgError(err, "23505")) return next(new ValidationError("A consultant with that slug or WhatsApp number id already exists"));
    next(fail(err));
  } finally {
    client.release();
  }
});

adminRouter.get("/tenants/:slug", async (req, res, next) => {
  try {
    const result = await pool.query(`${withCounts} WHERE t.slug = $1`, [req.params.slug]);
    if (result.rowCount === 0) throw new NotFoundError(`Unknown consultant: ${req.params.slug}`);
    res.json({ consultant: consultantView(result.rows[0]) });
  } catch (err) {
    next(err);
  }
});

const updateSchema = z
  .object({ name: z.string().trim().min(2).max(100), timezone, whatsappPhoneNumberId: z.string().trim().min(1).max(64).nullable() })
  .partial();

adminRouter.put("/tenants/:slug", async (req, res, next) => {
  try {
    const patch = updateSchema.parse(req.body ?? {});
    const tenant = await findTenant(req.params.slug);
    const result = await pool.query(
      `UPDATE tenants SET name = $2, timezone = $3, whatsapp_phone_number_id = $4 WHERE id = $1 RETURNING id`,
      [
        tenant.id,
        patch.name ?? tenant.name,
        patch.timezone ?? tenant.timezone,
        patch.whatsappPhoneNumberId === undefined ? tenant.whatsapp_phone_number_id : patch.whatsappPhoneNumberId,
      ]
    );
    const updated = await pool.query(`${withCounts} WHERE t.id = $1`, [result.rows[0].id]);
    res.json({ consultant: consultantView(updated.rows[0]) });
  } catch (err) {
    if (isPgError(err, "23505")) return next(new ValidationError("That WhatsApp phone number id is already used by another consultant"));
    next(fail(err));
  }
});

// ---- the consultant's logins (the people who sign in at /consultant/) ----

adminRouter.get("/tenants/:slug/users", async (req, res, next) => {
  try {
    const tenant = await findTenant(req.params.slug);
    const result = await pool.query("SELECT id, email, created_at FROM staff_users WHERE tenant_id = $1 ORDER BY created_at ASC", [tenant.id]);
    res.json({ users: result.rows.map((u) => ({ id: u.id, email: u.email, createdAt: u.created_at })) });
  } catch (err) {
    next(err);
  }
});

adminRouter.post("/tenants/:slug/users", async (req, res, next) => {
  try {
    const input = z.object({ email, password }).parse(req.body ?? {});
    const tenant = await findTenant(req.params.slug);
    if (await emailTaken(input.email)) throw new ValidationError("That email is already used by another consultant login");
    const result = await pool.query(
      "INSERT INTO staff_users (tenant_id, email, password_hash) VALUES ($1, $2, $3) RETURNING id, email, created_at",
      [tenant.id, input.email, await bcrypt.hash(input.password, 10)]
    );
    res.status(201).json({ user: { id: result.rows[0].id, email: result.rows[0].email, createdAt: result.rows[0].created_at } });
  } catch (err) {
    next(fail(err));
  }
});

adminRouter.post("/tenants/:slug/users/:id/password", async (req, res, next) => {
  try {
    const input = z.object({ password }).parse(req.body ?? {});
    const tenant = await findTenant(req.params.slug);
    const result = await pool.query("UPDATE staff_users SET password_hash = $3 WHERE id = $1 AND tenant_id = $2", [
      req.params.id, tenant.id, await bcrypt.hash(input.password, 10),
    ]);
    if (result.rowCount === 0) throw new NotFoundError("Login not found");
    res.json({ ok: true });
  } catch (err) {
    next(fail(err));
  }
});

adminRouter.delete("/tenants/:slug/users/:id", async (req, res, next) => {
  try {
    const tenant = await findTenant(req.params.slug);
    const count = await pool.query("SELECT count(*)::int AS n FROM staff_users WHERE tenant_id = $1", [tenant.id]);
    if (count.rows[0].n <= 1) throw new ValidationError("A consultant needs at least one login; add another first");
    const result = await pool.query("DELETE FROM staff_users WHERE id = $1 AND tenant_id = $2", [req.params.id, tenant.id]);
    if (result.rowCount === 0) throw new NotFoundError("Login not found");
    res.status(204).end();
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

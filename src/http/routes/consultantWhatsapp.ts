import { randomInt } from "crypto";
import { Router } from "express";
import { z } from "zod";
import { config, isEmbeddedSignupConfigured } from "../../config";
import { decrypt, encrypt } from "../../lib/crypto";
import { isPgError, pool } from "../../lib/db";
import { NotFoundError, ValidationError } from "../../errors";
import { rateLimit } from "../../lib/rateLimit";
import { clearCredentialCache } from "../../channels/whatsapp";
import * as meta from "../../channels/metaGraph";

// A consultant connects their OWN WhatsApp Business number (Meta's Embedded Signup), so users chat with the clinic's own
// number. The dashboard runs the Facebook login popup; this API turns its result into a stored, encrypted business token.
// Mounted under /v1/consultant/whatsapp (behind requireAuth); everything is scoped to the token's tenant.

export const consultantWhatsappRouter = Router();

const tenantOf = (req: { consultant?: { tenantId: string } }) => req.consultant!.tenantId;
const loadTenant = async (id: string) => (await pool.query("SELECT * FROM tenants WHERE id = $1", [id])).rows[0];

function metaMessage(err: unknown): string {
  return err instanceof meta.GraphError ? err.message : err instanceof Error ? err.message : "Something went wrong talking to Meta";
}

/** What the dashboard shows. Live details come from Meta where possible, but a Meta hiccup never breaks the page. */
async function connectionView(t: any) {
  const mode = t.whatsapp_access_token_encrypted ? "own" : t.whatsapp_phone_number_id ? "platform" : "none";
  const view: Record<string, unknown> = {
    mode, // own = the consultant's connected number · platform = a number the platform operator added (e.g. Meta's test number)
    phoneNumberId: t.whatsapp_phone_number_id,
    displayPhone: t.whatsapp_display_phone,
    verifiedName: t.whatsapp_verified_name,
    connectedAt: t.whatsapp_connected_at,
    template: t.whatsapp_template_name ? { name: t.whatsapp_template_name, status: null as string | null } : null,
    quality: null as string | null,
  };
  if (mode === "own") {
    const token = decrypt(t.whatsapp_access_token_encrypted);
    await Promise.all([
      meta.phoneDetails(token, t.whatsapp_phone_number_id).then((d) => {
        view.displayPhone = d.display_phone_number ?? view.displayPhone;
        view.verifiedName = d.verified_name ?? view.verifiedName;
        view.quality = d.quality_rating ?? null;
      }).catch(() => undefined),
      t.whatsapp_template_name && t.whatsapp_waba_id
        ? meta.templateStatus(token, t.whatsapp_waba_id, t.whatsapp_template_name).then((status) => { (view.template as { status: string | null }).status = status; }).catch(() => undefined)
        : Promise.resolve(),
    ]);
  }
  return view;
}

consultantWhatsappRouter.get("/", async (req, res, next) => {
  try {
    res.json({
      signup: {
        available: isEmbeddedSignupConfigured,
        // Both are public identifiers (the browser SDK needs them); the app secret never leaves the server.
        appId: isEmbeddedSignupConfigured ? config.whatsapp.appId : null,
        configId: isEmbeddedSignupConfigured ? config.whatsapp.embeddedSignupConfigId : null,
        graphVersion: config.whatsapp.graphVersion,
      },
      connection: await connectionView(await loadTenant(tenantOf(req))),
    });
  } catch (err) {
    next(err);
  }
});

/** The steps after the token is saved. Each is retryable, so a failure is a warning (with a Retry button), not a lost login. */
async function finishSetup(token: string, wabaId: string, phoneNumberId: string, pin: string): Promise<{ warnings: string[]; template: string | null }> {
  const warnings: string[] = [];
  try {
    await meta.registerPhone(token, phoneNumberId, pin);
  } catch (err) {
    // an already-registered number is fine; anything else means it can't send yet
    if (!/already|registered/i.test(metaMessage(err))) warnings.push(`Couldn't register the number for messaging: ${metaMessage(err)}`);
  }
  try {
    await meta.subscribeApp(token, wabaId);
  } catch (err) {
    warnings.push(`Couldn't subscribe to incoming messages: ${metaMessage(err)}`);
  }
  let template: string | null = null;
  try {
    await meta.createNotifyTemplate(token, wabaId);
    template = meta.NOTIFY_TEMPLATE_NAME;
  } catch (err) {
    warnings.push(`Couldn't create the notification template (reminders and alerts outside 24 hours need it): ${metaMessage(err)}`);
  }
  return { warnings, template };
}

const connectSchema = z.object({
  code: z.string().min(5).max(2000),
  phoneNumberId: z.string().regex(/^\d{5,30}$/, "invalid phone number id"),
  wabaId: z.string().regex(/^\d{5,30}$/, "invalid WhatsApp account id"),
});

consultantWhatsappRouter.post("/connect", rateLimit("wa-connect", 10, 60 * 60_000), async (req, res, next) => {
  try {
    if (!isEmbeddedSignupConfigured) throw new ValidationError("Connecting your own number isn't enabled on this server yet (the platform needs a Meta app and signup configuration)");
    const input = connectSchema.parse(req.body ?? {});
    const token = await meta.exchangeCode(input.code).catch((err) => { throw new ValidationError(metaMessage(err)); });

    // The browser told us which account and number; trust only what the token itself can see.
    const phones = await meta.listWabaPhones(token, input.wabaId).catch((err) => { throw new ValidationError(`That WhatsApp account isn't reachable: ${metaMessage(err)}`); });
    const phone = phones.find((p) => p.id === input.phoneNumberId);
    if (!phone) throw new ValidationError("That number doesn't belong to the WhatsApp account you connected");

    const pin = String(randomInt(100_000, 1_000_000));
    try {
      await pool.query(
        `UPDATE tenants SET whatsapp_phone_number_id = $2, whatsapp_waba_id = $3, whatsapp_access_token_encrypted = $4, whatsapp_register_pin_encrypted = $5,
           whatsapp_display_phone = $6, whatsapp_verified_name = $7, whatsapp_connected_at = now() WHERE id = $1`,
        [tenantOf(req), phone.id, input.wabaId, encrypt(token), encrypt(pin), phone.display_phone_number, phone.verified_name]
      );
    } catch (err) {
      if (isPgError(err, "23505")) throw new ValidationError("That WhatsApp number is already connected to another consultant");
      throw err;
    }
    clearCredentialCache();

    const { warnings, template } = await finishSetup(token, input.wabaId, phone.id, pin);
    if (template) await pool.query("UPDATE tenants SET whatsapp_template_name = $2 WHERE id = $1", [tenantOf(req), template]);
    clearCredentialCache();
    res.status(201).json({ connection: await connectionView(await loadTenant(tenantOf(req))), warnings });
  } catch (err) {
    next(err instanceof z.ZodError ? new ValidationError(`${err.issues[0]?.path.join(".")}: ${err.issues[0]?.message}`) : err);
  }
});

// Re-run the setup steps with the stored token (register / subscribe / template) after a warning.
consultantWhatsappRouter.post("/repair", rateLimit("wa-repair", 20, 60 * 60_000), async (req, res, next) => {
  try {
    const t = await loadTenant(tenantOf(req));
    if (!t.whatsapp_access_token_encrypted || !t.whatsapp_waba_id) throw new NotFoundError("No connected WhatsApp number to repair");
    const token = decrypt(t.whatsapp_access_token_encrypted);
    const pin = t.whatsapp_register_pin_encrypted ? decrypt(t.whatsapp_register_pin_encrypted) : String(randomInt(100_000, 1_000_000));
    const { warnings, template } = await finishSetup(token, t.whatsapp_waba_id, t.whatsapp_phone_number_id, pin);
    if (template) await pool.query("UPDATE tenants SET whatsapp_template_name = $2 WHERE id = $1", [tenantOf(req), template]);
    clearCredentialCache();
    res.json({ connection: await connectionView(await loadTenant(tenantOf(req))), warnings });
  } catch (err) {
    next(err);
  }
});

// Disconnect: stop receiving for this clinic and forget the token. (The number itself stays registered in the
// consultant's own WhatsApp account; they manage it in Meta's WhatsApp Manager.)
consultantWhatsappRouter.delete("/", async (req, res, next) => {
  try {
    const t = await loadTenant(tenantOf(req));
    if (t.whatsapp_access_token_encrypted && t.whatsapp_waba_id) {
      await meta.unsubscribeApp(decrypt(t.whatsapp_access_token_encrypted), t.whatsapp_waba_id).catch(() => undefined);
    }
    await pool.query(
      `UPDATE tenants SET whatsapp_phone_number_id = NULL, whatsapp_waba_id = NULL, whatsapp_access_token_encrypted = NULL, whatsapp_register_pin_encrypted = NULL,
         whatsapp_display_phone = NULL, whatsapp_verified_name = NULL, whatsapp_template_name = NULL, whatsapp_connected_at = NULL WHERE id = $1`,
      [tenantOf(req)]
    );
    clearCredentialCache();
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

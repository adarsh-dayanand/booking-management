import { createHmac, timingSafeEqual } from "crypto";
import { config } from "../config";
import { pool } from "../lib/db";
import { decrypt } from "../lib/crypto";
import type { ChatResponse } from "../chat/guidedFlow";

/** Verifies Meta's X-Hub-Signature-256 header against the raw request body. */
export function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!config.whatsapp.appSecret) {
    // Unsigned webhooks let anyone impersonate a patient or the doctor, so only tolerate this outside production.
    return !config.isProduction;
  }
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", config.whatsapp.appSecret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  return expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);
}

interface SendCredentials { token: string; templateName: string | null }

const credentialCache = new Map<string, { value: SendCredentials | null; expires: number }>();
export const clearCredentialCache = (): void => credentialCache.clear();

/**
 * Which token sends on this WhatsApp number. A consultant who connected their own number (Embedded Signup) has their own
 * business token; any other number — Meta's test number, a platform-owned one — uses the platform-wide token.
 * Cached briefly, since every outgoing message asks.
 */
export async function credentialsFor(phoneNumberId: string): Promise<SendCredentials | null> {
  const hit = credentialCache.get(phoneNumberId);
  if (hit && hit.expires > Date.now()) return hit.value;
  const row = (await pool.query("SELECT whatsapp_access_token_encrypted, whatsapp_template_name FROM tenants WHERE whatsapp_phone_number_id = $1", [phoneNumberId])).rows[0];
  let value: SendCredentials | null = null;
  if (row?.whatsapp_access_token_encrypted) value = { token: decrypt(row.whatsapp_access_token_encrypted), templateName: row.whatsapp_template_name ?? null };
  else if (config.whatsapp.accessToken) value = { token: config.whatsapp.accessToken, templateName: row?.whatsapp_template_name ?? config.whatsapp.notifyTemplate ?? null };
  credentialCache.set(phoneNumberId, { value, expires: Date.now() + 30_000 });
  return value;
}

export async function sendTextMessage(phoneNumberId: string, to: string, text: string): Promise<void> {
  await graphPost(phoneNumberId, { to, type: "text", text: { body: text } });
}

async function graphPost(phoneNumberId: string, payload: object): Promise<void> {
  const creds = await credentialsFor(phoneNumberId);
  if (!creds) throw new Error("WhatsApp is not configured for this number (no access token)");
  const response = await fetch(`https://graph.facebook.com/${config.whatsapp.graphVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${creds.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  if (!response.ok) throw new Error(`WhatsApp send failed (${response.status}): ${await response.text()}`);
}

export async function sendTemplateMessage(phoneNumberId: string, to: string, text: string): Promise<void> {
  const template = (await credentialsFor(phoneNumberId))?.templateName;
  if (!template) throw new Error("No message template is set up for this number");
  // Template variables can't contain newlines/tabs or long runs of spaces.
  const flat = text.replace(/\s*\n+\s*/g, " | ").replace(/ {2,}/g, " ").slice(0, 900);
  await graphPost(phoneNumberId, {
    to,
    type: "template",
    template: {
      name: template,
      language: { code: config.whatsapp.notifyTemplateLang },
      components: [{ type: "body", parameters: [{ type: "text", text: flat }] }],
    },
  });
}

export type DeliveryResult = "sent" | "skipped" | "failed";

/**
 * Business-initiated message (reminder, approval request, doctor-side change). Free text only works inside
 * the 24h window after the recipient last wrote to us, so on failure fall back to the approved template.
 */
export async function deliver(phoneNumberId: string | null, to: string, text: string): Promise<DeliveryResult> {
  if (!phoneNumberId || !to || !(await credentialsFor(phoneNumberId))) return "skipped";
  try {
    await sendTextMessage(phoneNumberId, to, text);
    return "sent";
  } catch (textErr) {
    if (!(await credentialsFor(phoneNumberId))?.templateName) {
      console.warn("[whatsapp] free-text send failed and no fallback template is configured:", textErr);
      return "failed";
    }
    try {
      await sendTemplateMessage(phoneNumberId, to, text);
      return "sent";
    } catch (templateErr) {
      console.warn("[whatsapp] template fallback failed:", templateErr);
      return "failed";
    }
  }
}

/** Numbered-list guided flows work fine as plain text over WhatsApp — no message templates needed. */
export function renderAsText(response: ChatResponse): string {
  if (!response.options?.length) return response.replyText;
  return `${response.replyText}\n\n${response.options.map((o) => o.label).join("\n")}`;
}

/** What Meta's most common delivery-failure codes mean in practice (https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes). */
const ERROR_HINTS: Record<number, string> = {
  131030: "the recipient isn't on the test number's allowed list: add and verify it under API Setup → Recipient",
  131047: "outside the 24-hour window: free text is only allowed within 24h of the person's last message; use an approved template",
  131026: "undeliverable: the number isn't on WhatsApp, or hasn't accepted WhatsApp's latest terms, or runs an unsupported WhatsApp version",
  131049: "Meta chose not to deliver (its per-user marketing/engagement limits); common for test numbers: try again later or message the bot first",
  131051: "unsupported message type",
  131056: "too many messages to this person from this number too quickly",
  130429: "throughput limit reached: slow down",
  132000: "template parameter count doesn't match the approved template",
  132001: "template doesn't exist (check its name and language)",
  190: "the access token is invalid or has expired: generate a new one (test tokens last about 24 hours)",
};

/** A readable line for one delivery-status update from Meta's webhook, or null if it isn't worth logging. */
export function describeStatus(status: any): string | null {
  if (!status?.status) return null;
  const to = status.recipient_id ? `+${status.recipient_id}` : "recipient";
  const id = String(status.id ?? "").slice(-12);
  if (status.status !== "failed") return `[whatsapp] message …${id} to ${to}: ${status.status}`;
  const err = status.errors?.[0];
  const code = err?.code as number | undefined;
  const hint = code !== undefined ? ERROR_HINTS[code] : undefined;
  return `[whatsapp] message …${id} to ${to} FAILED${code !== undefined ? ` (code ${code})` : ""}: ${err?.title ?? err?.message ?? "unknown error"}${err?.error_data?.details ? ` — ${err.error_data.details}` : ""}${hint ? `\n  → ${hint}` : ""}`;
}

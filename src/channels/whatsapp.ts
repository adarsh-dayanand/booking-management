import { createHmac, timingSafeEqual } from "crypto";
import { config } from "../config";
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

export async function sendTextMessage(phoneNumberId: string, to: string, text: string): Promise<void> {
  await graphPost(phoneNumberId, { to, type: "text", text: { body: text } });
}

async function graphPost(phoneNumberId: string, payload: object): Promise<void> {
  if (!config.whatsapp.accessToken) throw new Error("WhatsApp is not configured (missing WHATSAPP_ACCESS_TOKEN)");
  const response = await fetch(`https://graph.facebook.com/${config.whatsapp.graphVersion}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.whatsapp.accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", ...payload }),
  });
  if (!response.ok) throw new Error(`WhatsApp send failed (${response.status}): ${await response.text()}`);
}

export async function sendTemplateMessage(phoneNumberId: string, to: string, text: string): Promise<void> {
  const template = config.whatsapp.notifyTemplate;
  if (!template) throw new Error("No WHATSAPP_NOTIFY_TEMPLATE configured");
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
  if (!phoneNumberId || !config.whatsapp.accessToken || !to) return "skipped";
  try {
    await sendTextMessage(phoneNumberId, to, text);
    return "sent";
  } catch (textErr) {
    if (!config.whatsapp.notifyTemplate) {
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

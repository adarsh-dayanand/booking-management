import { createHmac, timingSafeEqual } from "crypto";
import { config } from "../config";
import type { ChatResponse } from "../chat/guidedFlow";

const GRAPH_API_VERSION = "v20.0";

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
  const response = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
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

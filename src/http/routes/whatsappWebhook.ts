import { Router } from "express";
import { config } from "../../config";
import { handleIncomingMessage } from "../../chat/conversation";
import { pool } from "../../lib/db";
import { allow } from "../../lib/rateLimit";
import { handleStaffMessage, isStaffNumber } from "../../channels/staffCommands";
import { touchPatient } from "../../booking/patients";
import { loadTenantConfig, getTenantSlugByWhatsappPhoneNumberId } from "../../booking/tenant";
import * as whatsapp from "../../channels/whatsapp";

export const whatsappWebhookRouter = Router();

// Meta's one-time webhook verification handshake.
whatsappWebhookRouter.get("/", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === config.whatsapp.verifyToken) {
    res.status(200).send(String(challenge ?? ""));
  } else {
    res.sendStatus(403);
  }
});

/** Meta redelivers webhooks; true only the first time we see a message id. */
async function firstDelivery(messageId: string): Promise<boolean> {
  const result = await pool.query(
    "INSERT INTO processed_messages (message_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING message_id",
    [messageId]
  );
  return (result.rowCount ?? 0) > 0;
}

async function processMessage(phoneNumberId: string, message: any, contacts: any[] = []): Promise<void> {
  if (message.id && !(await firstDelivery(message.id))) return;

  const from: string = message.from;
  const tenantConfig = await loadTenantConfig(await getTenantSlugByWhatsappPhoneNumberId(phoneNumberId));
  const text: string | undefined =
    message.text?.body ?? message.interactive?.button_reply?.title ?? message.interactive?.list_reply?.title ?? message.button?.text;
  const reply = (body: string) => whatsapp.sendTextMessage(phoneNumberId, from, body);

  // The doctor/clinic number gets the staff command channel instead of the patient agent.
  if (isStaffNumber(tenantConfig.tenant.staffWhatsappNumber, from)) {
    await reply(await handleStaffMessage(tenantConfig, text ?? ""));
    return;
  }

  // No registration: the first message from a number creates the patient, with the WhatsApp profile name Meta
  // supplies. Fail-soft — never let a capture problem stop the patient's query being answered.
  const profileName: string | undefined = contacts.find((c) => c?.wa_id === from)?.profile?.name;
  await touchPatient(tenantConfig.tenant.id, from, {
    channel: "whatsapp",
    name: profileName,
    nameSource: "whatsapp_profile",
    verified: true, // the sender number comes from Meta's signed webhook
  }).catch((err) => console.warn("[whatsappWebhook] could not record patient:", err));

  if (!text) {
    await reply("Sorry, I can only read text messages. Please type your request.");
    return;
  }
  if (!allow(`wa:${tenantConfig.tenant.id}:${from}`, 20, 60_000)) {
    await reply("You're sending messages very quickly — please wait a moment.");
    return;
  }

  const result = await handleIncomingMessage(tenantConfig.tenant.slug, "whatsapp", from, text);
  await reply(whatsapp.renderAsText(result));
}

whatsappWebhookRouter.post("/", async (req, res) => {
  const signatureHeader = req.headers["x-hub-signature-256"];
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  const rawBody = (req as any).rawBody as Buffer | undefined;

  if (!rawBody || !whatsapp.verifyWebhookSignature(rawBody, signature)) {
    res.sendStatus(401);
    return;
  }

  // Acknowledge immediately so Meta doesn't retry; process the messages after.
  res.sendStatus(200);

  for (const entry of req.body?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const phoneNumberId: string | undefined = change?.value?.metadata?.phone_number_id;
      if (!phoneNumberId) continue;
      for (const message of change.value.messages ?? []) {
        try {
          await processMessage(phoneNumberId, message, change.value.contacts);
        } catch (err) {
          console.error(`[whatsappWebhook] failed to process message ${message?.id}:`, err);
        }
      }
    }
  }
});

import { Router } from "express";
import { config } from "../config";
import { handleIncomingMessage } from "../guidedFlow";
import { getTenantSlugByWhatsappPhoneNumberId } from "../tenant";
import * as whatsapp from "../whatsapp";

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

whatsappWebhookRouter.post("/", async (req, res) => {
  const signatureHeader = req.headers["x-hub-signature-256"];
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  const rawBody = (req as any).rawBody as Buffer | undefined;

  if (!rawBody || !whatsapp.verifyWebhookSignature(rawBody, signature)) {
    res.sendStatus(401);
    return;
  }

  // Acknowledge immediately so Meta doesn't retry; process the message after.
  res.sendStatus(200);

  try {
    const change = req.body?.entry?.[0]?.changes?.[0]?.value;
    const phoneNumberId: string | undefined = change?.metadata?.phone_number_id;
    const message = change?.messages?.[0];
    if (!phoneNumberId || !message) return; // e.g. a delivery-status callback, not an inbound message

    const from: string = message.from;
    const text: string =
      message.text?.body ?? message.interactive?.button_reply?.title ?? message.button?.text ?? "";

    const tenantSlug = await getTenantSlugByWhatsappPhoneNumberId(phoneNumberId);
    const result = await handleIncomingMessage(tenantSlug, "whatsapp", from, text);
    await whatsapp.sendTextMessage(phoneNumberId, from, whatsapp.renderAsText(result));
  } catch (err) {
    console.error("[whatsappWebhook] failed to process inbound message:", err);
  }
});

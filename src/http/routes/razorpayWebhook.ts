import { Router } from "express";
import { loadWebhookSecret } from "../../payments/store";
import { verifyWebhookSignature } from "../../payments/razorpay";
import { settlePaidLink } from "../../payments/settlement";

export const razorpayWebhookRouter = Router();

// One URL per clinic (the clinic's own webhook secret signs it): POST /v1/webhooks/razorpay/:tenantSlug
// Razorpay retries non-2xx responses, so a transient failure while settling returns 500 and is redelivered;
// settlePaidLink is idempotent, so redelivery is harmless.
razorpayWebhookRouter.post("/:tenantSlug", async (req, res) => {
  const rawBody = req.rawBody;
  const signature = req.headers["x-razorpay-signature"];
  const secret = await loadWebhookSecret(req.params.tenantSlug).catch(() => null);
  if (!secret || !rawBody || !verifyWebhookSignature(rawBody, Array.isArray(signature) ? signature[0] : signature, secret.secret)) {
    res.sendStatus(401);
    return;
  }

  try {
    if (req.body?.event === "payment_link.paid") {
      const link = req.body.payload?.payment_link?.entity;
      const payment = req.body.payload?.payment?.entity;
      if (link?.id) {
        // Tenant comes from the verified secret's owner, so one clinic can't settle another's payments.
        await settlePaidLink(secret.tenantId, { id: link.id, amountPaid: Number(link.amount_paid ?? 0), paymentId: payment?.id ?? null });
      }
    }
    // Other events (expired / cancelled / payment.failed) need no action: the scheduler releases unpaid holds.
    res.sendStatus(200);
  } catch (err) {
    console.error("[razorpay webhook] failed to process event:", err);
    res.sendStatus(500);
  }
});

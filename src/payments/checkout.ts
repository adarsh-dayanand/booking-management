import { pool } from "../lib/db";
import { ValidationError } from "../errors";
import { normalizePhone } from "../lib/phone";
import { toOffer, type PaymentOffer } from "./offer";
import * as razorpay from "./razorpay";
import * as payments from "./store";

/**
 * Creates the Razorpay link for a freshly held (AWAITING_PAYMENT) appointment. If Razorpay can't be reached the
 * hold is released at once, so a payment outage never leaves phantom reservations blocking the doctor's calendar.
 */
export async function openPaymentLink(
  credentials: razorpay.RazorpayCredentials,
  p: {
    appointmentId: string;
    amountPaise: number;
    description: string;
    expiresAt: Date;
    patient: { name: string; phone: string };
  }
): Promise<PaymentOffer> {
  try {
    const link = await razorpay.createPaymentLink(credentials, {
      amountPaise: p.amountPaise,
      currency: "INR",
      description: p.description,
      referenceId: p.appointmentId,
      expiresAt: p.expiresAt,
      customer: { name: p.patient.name, contact: `+${normalizePhone(p.patient.phone)}` },
    });
    await payments.attachLink(p.appointmentId, link.id, link.shortUrl);
    return toOffer({ appointmentId: p.appointmentId, linkUrl: link.shortUrl, amountPaise: p.amountPaise, expiresAt: p.expiresAt });
  } catch (err) {
    console.warn(`[payments] could not create a payment link for ${p.appointmentId}; releasing the slot:`, err);
    await pool.query(
      `UPDATE appointments SET status = 'CANCELLED', cancel_reason = 'Payment could not be started', version = version + 1, updated_at = now()
       WHERE id = $1 AND status = 'AWAITING_PAYMENT'`,
      [p.appointmentId]
    );
    await payments.markStatus(p.appointmentId, "failed");
    throw new ValidationError("We couldn't start the payment just now, so the time was not held. Please try again in a moment.");
  }
}

/** Cancelling a booking that was never paid also kills its payment link, so the patient can't pay for a slot that's gone. */
export async function voidUnpaidPayment(tenantId: string, appointmentId: string): Promise<void> {
  try {
    const payment = await payments.getByAppointment(tenantId, appointmentId);
    if (!payment || payment.status !== "created") return;
    await payments.markStatus(appointmentId, "cancelled");
    const credentials = payment.linkId ? await payments.loadCredentials(tenantId) : null;
    if (credentials && payment.linkId) await razorpay.cancelPaymentLink(credentials, payment.linkId);
  } catch (err) {
    console.warn(`[payments] could not void the payment link for ${appointmentId}:`, err);
  }
}

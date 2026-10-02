import { formatRupees } from "./pricing";
import type { PaymentRow } from "./store";

/** What the chat shows a patient who still has to pay: a link, an amount, and a deadline. */
export interface PaymentOffer {
  appointmentId: string;
  url: string;
  amountPaise: number;
  amount: string; // "₹500"
  expiresAt: string; // ISO
}

export function toOffer(p: Pick<PaymentRow, "appointmentId" | "linkUrl" | "amountPaise" | "expiresAt">): PaymentOffer {
  return {
    appointmentId: p.appointmentId,
    url: p.linkUrl ?? "",
    amountPaise: p.amountPaise,
    amount: formatRupees(p.amountPaise),
    expiresAt: p.expiresAt.toISOString(),
  };
}

/** Plain-text channels (WhatsApp) can't render a button, so the link must be in the message itself. */
export function appendPaymentLink(text: string, offer: PaymentOffer | undefined): string {
  if (!offer || !offer.url || text.includes(offer.url)) return text;
  return `${text}\n\nPay ${offer.amount} securely here to confirm your booking:\n${offer.url}`;
}

/** What to tell the patient once the payment's fate is known; null while it is still pending. */
export function describeOutcome(state: { paymentStatus: string; appointmentStatus: string }): string | null {
  if (state.paymentStatus === "paid") {
    return state.appointmentStatus === "CONFIRMED"
      ? "Payment received, thank you! Your appointment is confirmed."
      : "Payment received, thank you! Your request is now with the doctor, who will confirm it shortly. We'll message you on WhatsApp.";
  }
  if (state.paymentStatus === "expired" || state.paymentStatus === "cancelled" || state.paymentStatus === "failed") {
    return "The payment wasn't completed, so the time slot has been released. Message me whenever you'd like to book again.";
  }
  return null;
}

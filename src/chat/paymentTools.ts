import { z } from "zod";
import { identityPhone, label, NOT_VERIFIED, ownsAppointment, uuid, type Tool } from "./toolKit";
import { describeOutcome, toOffer } from "../payments/offer";
import { reconcileAppointment } from "../payments/settlement";
import * as payments from "../payments/store";

/** Tools that only exist to serve the Razorpay flow. Registered with the other agent tools in agentTools.ts. */
export const paymentTools: Tool[] = [
  {
    write: false,
    declaration: {
      name: "check_payment_status",
      description:
        "Check whether the patient has paid for an appointment that was AWAITING_PAYMENT. Call it when they say they've paid or ask about their payment. If paid, the booking is confirmed (or sent to the doctor) automatically.",
      parameters: { type: "object", properties: { appointmentId: { type: "string" } }, required: ["appointmentId"] },
    },
    run: async (raw, ctx) => {
      const args = z.object({ appointmentId: uuid }).parse(raw);
      if (!(await ownsAppointment(ctx, args.appointmentId))) return identityPhone(ctx) ? { error: "That appointment doesn't belong to this patient." } : NOT_VERIFIED;
      const state = await reconcileAppointment(ctx.config.tenant.id, args.appointmentId);
      if (!state) return { error: "No payment is required for that appointment." };

      const outcome = describeOutcome(state);
      if (outcome) return { paymentStatus: state.paymentStatus, appointmentStatus: state.appointmentStatus, meaning: outcome };

      // Still unpaid: hand the same link back so the patient can finish.
      const payment = await payments.getByAppointment(ctx.config.tenant.id, args.appointmentId);
      if (!payment?.linkUrl) return { paymentStatus: state.paymentStatus, appointmentStatus: state.appointmentStatus };
      const offer = toOffer(payment);
      if (ctx.outbox) ctx.outbox.payment = offer;
      return {
        paymentStatus: "unpaid",
        appointmentStatus: state.appointmentStatus,
        amount: offer.amount,
        paymentUrl: offer.url,
        payBefore: label(offer.expiresAt, ctx.config.tenant.timezone),
        meaning: "Payment has NOT been received yet. The slot stays held until payBefore. Share the link again.",
      };
    },
  },
];

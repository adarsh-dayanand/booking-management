import { pool } from "../lib/db";
import { mapAppointment, syncToCalendar } from "../booking/booking";
import { loadTenantConfigById } from "../booking/tenant";
import { appointmentRef, notifyAppointmentEvent, notifyStaff } from "../channels/notify";
import * as razorpay from "./razorpay";
import * as payments from "./store";

export type SettleResult = "confirmed" | "already_settled" | "unknown_link" | "amount_mismatch" | "orphaned";

/**
 * A Razorpay link has been paid: record it and move the appointment out of AWAITING_PAYMENT into the status the
 * clinic's flow dictates (CONFIRMED for instant, PENDING_CONFIRMATION when the doctor still has to accept).
 *
 * Safe to call any number of times and from several places at once (webhook, the patient's poll, the scheduler):
 * the payment row is locked and only the first caller sees it as 'created'.
 */
export async function settlePaidLink(tenantId: string, link: Pick<razorpay.PaymentLink, "id" | "amountPaid" | "paymentId">): Promise<SettleResult> {
  const client = await pool.connect();
  let appointmentId: string;
  try {
    await client.query("BEGIN");
    const found = await client.query(
      "SELECT * FROM payments WHERE razorpay_payment_link_id = $1 AND tenant_id = $2 FOR UPDATE",
      [link.id, tenantId]
    );
    const payment = found.rows[0];
    if (!payment) {
      await client.query("ROLLBACK");
      return "unknown_link";
    }
    appointmentId = payment.appointment_id;
    if (payment.status === "paid") {
      await client.query("ROLLBACK");
      return "already_settled";
    }
    // Never trust a "paid" signal that doesn't cover the fee we quoted.
    if (link.amountPaid < payment.amount_paise) {
      await client.query("ROLLBACK");
      console.warn(`[payments] link ${link.id} reports ${link.amountPaid} paise paid, expected ${payment.amount_paise}`);
      return "amount_mismatch";
    }
    await client.query(
      "UPDATE payments SET status = 'paid', razorpay_payment_id = $2, paid_at = now(), updated_at = now() WHERE id = $1",
      [payment.id, link.paymentId]
    );
    const confirmed = await client.query(
      `UPDATE appointments a
         SET status = CASE WHEN t.confirmation_policy = 'instant' THEN 'CONFIRMED' ELSE 'PENDING_CONFIRMATION' END,
             version = a.version + 1, updated_at = now()
       FROM tenants t
       WHERE a.id = $1 AND a.tenant_id = t.id AND a.status = 'AWAITING_PAYMENT'
       RETURNING a.*`,
      [appointmentId]
    );
    await client.query("COMMIT");
    if (confirmed.rowCount === 0) {
      // Money arrived for a booking that is no longer waiting (hold expired / cancelled in the meantime): a human must refund.
      await notifyStaff(
        tenantId,
        `Payment received for appointment ${appointmentRef(appointmentId)}, but that booking is no longer active. Please refund it in your Razorpay dashboard (payment ${link.paymentId ?? link.id}).`
      );
      return "orphaned";
    }
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  // Now that it's paid the booking behaves like any other: hold the doctor's calendar, tell the doctor, tell the patient.
  const config = await loadTenantConfigById(tenantId);
  const row = (await pool.query("SELECT * FROM appointments WHERE id = $1", [appointmentId])).rows[0];
  const resource = config.resources.find((r) => r.id === row.resource_id);
  if (resource) await syncToCalendar(resource, mapAppointment(row), "create");
  await notifyAppointmentEvent(appointmentId, "paid", "patient");
  return "confirmed";
}

/** The patient didn't pay in time (or the link died): release the slot. Returns false if it was no longer waiting. */
export async function expireHold(tenantId: string, appointmentId: string): Promise<boolean> {
  const released = await pool.query(
    `UPDATE appointments SET status = 'CANCELLED', cancel_reason = 'Payment not completed in time', version = version + 1, updated_at = now()
     WHERE id = $1 AND tenant_id = $2 AND status = 'AWAITING_PAYMENT' RETURNING id`,
    [appointmentId, tenantId]
  );
  if (released.rowCount === 0) return false;
  const payment = await payments.getByAppointment(tenantId, appointmentId);
  await payments.markStatus(appointmentId, "expired");
  try {
    const credentials = payment?.linkId ? await payments.loadCredentials(tenantId) : null;
    if (credentials && payment?.linkId) await razorpay.cancelPaymentLink(credentials, payment.linkId);
  } catch {
    /* an already-expired link can't be cancelled; that's fine */
  }
  await notifyAppointmentEvent(appointmentId, "payment_expired", "system");
  return true;
}

export interface PaymentState {
  paymentStatus: payments.PaymentRow["status"];
  appointmentStatus: string;
}

/**
 * Ask Razorpay what really happened to this appointment's payment link and act on it. This is what makes payment
 * work without a webhook (local dev, a missed delivery): the chat polls it, and the scheduler sweeps stale holds.
 */
export async function reconcileAppointment(tenantId: string, appointmentId: string): Promise<PaymentState | null> {
  let payment = await payments.getByAppointment(tenantId, appointmentId);
  if (!payment) return null;

  if (payment.status === "created" && payment.linkId) {
    const credentials = await payments.loadCredentials(tenantId);
    if (credentials) {
      try {
        const link = await razorpay.fetchPaymentLink(credentials, payment.linkId);
        if (link.status === "paid") await settlePaidLink(tenantId, link);
        else if (link.status === "expired" || link.status === "cancelled" || payment.expiresAt.getTime() < Date.now()) {
          await expireHold(tenantId, appointmentId);
        }
      } catch (err) {
        console.warn(`[payments] reconcile of ${appointmentId} failed:`, err); // unknown ≠ unpaid: leave the hold alone
      }
    }
    payment = (await payments.getByAppointment(tenantId, appointmentId))!;
  }
  const appt = await pool.query("SELECT status FROM appointments WHERE id = $1", [appointmentId]);
  return { paymentStatus: payment.status, appointmentStatus: appt.rows[0]?.status };
}

/** Scheduler step: resolve every hold whose payment window has closed. Returns how many holds were examined. */
export async function expireUnpaidHolds(limit = 50): Promise<number> {
  const due = await pool.query(
    `SELECT p.tenant_id, p.appointment_id FROM payments p JOIN appointments a ON a.id = p.appointment_id
     WHERE p.status = 'created' AND a.status = 'AWAITING_PAYMENT' AND p.expires_at < now()
     ORDER BY p.expires_at ASC LIMIT $1`,
    [limit]
  );
  for (const row of due.rows) {
    try {
      const state = await reconcileAppointment(row.tenant_id, row.appointment_id);
      // Razorpay unreachable or link status lagging behind its own deadline: the window is over, so release the slot.
      if (state?.appointmentStatus === "AWAITING_PAYMENT" && state.paymentStatus === "created") {
        await expireHold(row.tenant_id, row.appointment_id);
      }
    } catch (err) {
      console.warn(`[payments] expiring hold ${row.appointment_id} failed:`, err);
    }
  }
  return due.rowCount ?? 0;
}

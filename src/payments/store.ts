import type { PoolClient } from "pg";
import { pool } from "../lib/db";
import { decrypt } from "../lib/crypto";
import type { RazorpayCredentials } from "./razorpay";

export interface PaymentRow {
  id: string;
  tenantId: string;
  appointmentId: string;
  amountPaise: number;
  currency: string;
  band: string;
  status: "created" | "paid" | "expired" | "failed" | "cancelled";
  linkId: string | null;
  linkUrl: string | null;
  razorpayPaymentId: string | null;
  expiresAt: Date;
}

export function mapPayment(row: any): PaymentRow {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    appointmentId: row.appointment_id,
    amountPaise: row.amount_paise,
    currency: row.currency,
    band: row.band,
    status: row.status,
    linkId: row.razorpay_payment_link_id,
    linkUrl: row.razorpay_payment_link_url,
    razorpayPaymentId: row.razorpay_payment_id,
    expiresAt: new Date(row.expires_at),
  };
}

/** The consultant's decrypted Razorpay keys, or null when the admin hasn't enabled payments for it. */
export async function loadCredentials(tenantId: string): Promise<RazorpayCredentials | null> {
  const result = await pool.query(
    "SELECT payments_enabled, razorpay_key_id, razorpay_key_secret_encrypted FROM tenants WHERE id = $1",
    [tenantId]
  );
  const row = result.rows[0];
  if (!row?.payments_enabled || !row.razorpay_key_id || !row.razorpay_key_secret_encrypted) return null;
  return { keyId: row.razorpay_key_id, keySecret: decrypt(row.razorpay_key_secret_encrypted) };
}

export async function loadWebhookSecret(tenantSlug: string): Promise<{ tenantId: string; secret: string } | null> {
  const result = await pool.query(
    "SELECT id, payments_enabled, razorpay_webhook_secret_encrypted FROM tenants WHERE slug = $1",
    [tenantSlug]
  );
  const row = result.rows[0];
  if (!row?.payments_enabled || !row.razorpay_webhook_secret_encrypted) return null;
  return { tenantId: row.id, secret: decrypt(row.razorpay_webhook_secret_encrypted) };
}

export async function insertPayment(
  client: PoolClient,
  p: { tenantId: string; appointmentId: string; amountPaise: number; band: string; expiresAt: Date }
): Promise<void> {
  await client.query(
    `INSERT INTO payments (tenant_id, appointment_id, amount_paise, band, expires_at) VALUES ($1, $2, $3, $4, $5)`,
    [p.tenantId, p.appointmentId, p.amountPaise, p.band, p.expiresAt]
  );
}

export async function attachLink(appointmentId: string, linkId: string, linkUrl: string): Promise<void> {
  await pool.query(
    "UPDATE payments SET razorpay_payment_link_id = $2, razorpay_payment_link_url = $3, updated_at = now() WHERE appointment_id = $1",
    [appointmentId, linkId, linkUrl]
  );
}

export async function getByAppointment(tenantId: string, appointmentId: string): Promise<PaymentRow | null> {
  const result = await pool.query("SELECT * FROM payments WHERE appointment_id = $1 AND tenant_id = $2", [appointmentId, tenantId]);
  return result.rows[0] ? mapPayment(result.rows[0]) : null;
}

export async function markStatus(appointmentId: string, status: "failed" | "cancelled" | "expired"): Promise<void> {
  await pool.query("UPDATE payments SET status = $2, updated_at = now() WHERE appointment_id = $1 AND status = 'created'", [appointmentId, status]);
}

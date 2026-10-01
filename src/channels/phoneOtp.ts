import { createHash, randomInt, timingSafeEqual } from "crypto";
import { config } from "../config";
import { pool } from "../lib/db";
import { normalizePhone } from "../lib/phone";
import * as whatsapp from "./whatsapp";

const OTP_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
const MAX_SENDS_PER_HOUR = 3;

const hashCode = (tenantId: string, phone: string, code: string) =>
  createHash("sha256").update(`${tenantId}:${phone}:${code}`).digest("hex");

export type SendOtpResult =
  | { sent: true }
  | { sent: false; error: string }
  /** Dev only: WhatsApp isn't configured, so the code is handed back so the flow can still be tried (e.g. in Swagger). */
  | { sent: false; devCode: string; note: string };

export async function sendPhoneOtp(
  tenant: { id: string; name: string; whatsappPhoneNumberId: string | null },
  rawPhone: string
): Promise<SendOtpResult> {
  const phone = normalizePhone(rawPhone);
  const recent = await pool.query(
    "SELECT count(*)::int AS n FROM phone_otps WHERE tenant_id = $1 AND phone_normalized = $2 AND created_at > now() - interval '1 hour'",
    [tenant.id, phone]
  );
  if (recent.rows[0].n >= MAX_SENDS_PER_HOUR) return { sent: false, error: "Too many codes requested for this number. Try again in an hour." };

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await pool.query(
    `INSERT INTO phone_otps (tenant_id, phone_normalized, code_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(mins => $4))`,
    [tenant.id, phone, hashCode(tenant.id, phone, code), OTP_TTL_MINUTES]
  );

  const delivery = await whatsapp.deliver(
    tenant.whatsappPhoneNumberId,
    phone,
    `${code} is your ${tenant.name} verification code. It expires in ${OTP_TTL_MINUTES} minutes. Don't share it with anyone.`
  );
  if (delivery === "sent") return { sent: true };
  if (config.agentTraceEnabled && delivery === "skipped") {
    return { sent: false, devCode: code, note: "WhatsApp isn't configured, so the code was not sent (dev mode shows it here)." };
  }
  return { sent: false, error: "Couldn't deliver the code over WhatsApp. Ask the patient to message the clinic's WhatsApp number directly instead." };
}

export type VerifyOtpResult = { verified: true; phone: string } | { verified: false; error: string };

export async function verifyPhoneOtp(tenantId: string, rawPhone: string, code: string): Promise<VerifyOtpResult> {
  const phone = normalizePhone(rawPhone);
  const result = await pool.query(
    `SELECT id, code_hash, attempts FROM phone_otps
     WHERE tenant_id = $1 AND phone_normalized = $2 AND expires_at > now()
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId, phone]
  );
  const row = result.rows[0];
  if (!row) return { verified: false, error: "No active code for this number. Send a new code." };
  if (row.attempts >= MAX_ATTEMPTS) return { verified: false, error: "Too many wrong attempts. Send a new code." };

  const expected = Buffer.from(row.code_hash, "hex");
  const provided = Buffer.from(hashCode(tenantId, phone, code.trim()), "hex");
  if (!timingSafeEqual(expected, provided)) {
    await pool.query("UPDATE phone_otps SET attempts = attempts + 1 WHERE id = $1", [row.id]);
    return { verified: false, error: "That code is incorrect." };
  }
  await pool.query("DELETE FROM phone_otps WHERE tenant_id = $1 AND phone_normalized = $2", [tenantId, phone]);
  return { verified: true, phone };
}

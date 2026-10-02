import { DateTime } from "luxon";
import { z } from "zod";
import { pool } from "../lib/db";
import { touchPatient, type Patient } from "../booking/patients";
import { normalizePhone } from "../lib/phone";
import type { PaymentOffer } from "../payments/offer";
import type { Channel, TenantConfig } from "../types";

// Types and helpers shared by every agent tool (agentTools.ts, paymentTools.ts).

/** Per-conversation facts the agent can't be talked out of; persisted with the conversation. */
export interface AgentSession {
  /**
   * Phone (normalised digits) proven to belong to this chat. On WhatsApp the signed sender number is the proof
   * and this is never needed; on web it is set only by a successful verify_phone_otp.
   */
  verifiedPhone?: string;
  /** Web only: a number the visitor typed or the host page supplied. Unproven — it never grants access to anything. */
  claimedPhone?: string;
}

export interface ToolContext {
  config: TenantConfig;
  channel: Channel;
  externalId: string;
  session: AgentSession;
  /** Things a tool wants surfaced to the patient beyond the model's own words (e.g. a payment link button). */
  outbox?: { payment?: PaymentOffer };
}

export type ToolResult = Record<string, unknown>;
export interface Tool {
  declaration: { name: string; description: string; parameters: object };
  /** Writes change appointments; the agent loop uses this to avoid losing track of completed actions. */
  write: boolean;
  run: (args: any, ctx: ToolContext) => Promise<ToolResult>;
}

export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
export const isoDateTime = z.string().datetime({ offset: true });

/** The phone whose records this chat may read and change, or undefined if the visitor hasn't proven one. */
export function identityPhone(ctx: ToolContext): string | undefined {
  return ctx.channel === "whatsapp" ? normalizePhone(ctx.externalId) : ctx.session.verifiedPhone;
}

export const NOT_VERIFIED = {
  error:
    "The patient's phone number isn't verified yet. Ask for their phone number, call send_phone_otp, then verify_phone_otp with the code they receive on WhatsApp.",
};

/** The patient profile for the proven identity, created on the spot if this is the first time we see the number. */
export async function identityPatient(ctx: ToolContext): Promise<Patient | null> {
  const phone = identityPhone(ctx);
  if (!phone) return null;
  return touchPatient(ctx.config.tenant.id, phone, { channel: ctx.channel, verified: true });
}

export async function ownsAppointment(ctx: ToolContext, appointmentId: string): Promise<boolean> {
  const phone = identityPhone(ctx);
  if (!phone) return false;
  const result = await pool.query(
    `SELECT 1 FROM appointments a JOIN patients p ON p.id = a.patient_id
     WHERE a.id = $1 AND a.tenant_id = $2 AND p.phone_normalized = $3`,
    [appointmentId, ctx.config.tenant.id, phone]
  );
  return result.rows.length > 0;
}

export function label(iso: string | Date, tz: string): string {
  const dt = iso instanceof Date ? DateTime.fromJSDate(iso, { zone: tz }) : DateTime.fromISO(iso, { zone: "utc" }).setZone(tz);
  return dt.toFormat("ccc dd LLL yyyy, h:mm a"); // 12-hour: that is how patients say and read times
}


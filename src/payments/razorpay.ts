import { createHmac, timingSafeEqual } from "crypto";
import { config } from "../config";

// Thin Razorpay REST client (Payment Links). No SDK: three endpoints and one HMAC don't justify a dependency.
// A Payment Link is a hosted checkout page (UPI, cards, netbanking) — it works the same in a WhatsApp message
// and in the web widget, so the chat never has to embed Razorpay's checkout script.

export interface RazorpayCredentials {
  keyId: string;
  keySecret: string;
}

export class RazorpayError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "RazorpayError";
  }
}

async function call<T>(creds: RazorpayCredentials, method: "GET" | "POST", path: string, body?: object): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${config.payments.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new RazorpayError(`Could not reach Razorpay: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await response.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON error page */
  }
  if (!response.ok) throw new RazorpayError(data?.error?.description || `Razorpay returned ${response.status}`, response.status);
  return data as T;
}

export interface PaymentLink {
  id: string;
  shortUrl: string;
  status: string; // created | partially_paid | expired | cancelled | paid
  amount: number;
  amountPaid: number;
  paymentId: string | null;
}

function mapLink(raw: any): PaymentLink {
  return {
    id: raw.id,
    shortUrl: raw.short_url,
    status: raw.status,
    amount: raw.amount,
    amountPaid: raw.amount_paid ?? 0,
    paymentId: raw.payments?.find((p: any) => p.status === "captured")?.payment_id ?? raw.payments?.[0]?.payment_id ?? null,
  };
}

export async function createPaymentLink(
  creds: RazorpayCredentials,
  p: { amountPaise: number; currency: string; description: string; referenceId: string; expiresAt: Date; customer: { name: string; contact: string } }
): Promise<PaymentLink> {
  const raw = await call<any>(creds, "POST", "/payment_links", {
    amount: p.amountPaise,
    currency: p.currency,
    accept_partial: false,
    reference_id: p.referenceId,
    description: p.description.slice(0, 2000),
    expire_by: Math.floor(p.expiresAt.getTime() / 1000),
    customer: { name: p.customer.name, contact: p.customer.contact },
    notify: { sms: false, email: false }, // the chat delivers the link; don't double-message the patient
    reminder_enable: false,
    notes: { appointment_id: p.referenceId },
  });
  return mapLink(raw);
}

export async function fetchPaymentLink(creds: RazorpayCredentials, id: string): Promise<PaymentLink> {
  return mapLink(await call<any>(creds, "GET", `/payment_links/${encodeURIComponent(id)}`));
}

export async function cancelPaymentLink(creds: RazorpayCredentials, id: string): Promise<void> {
  await call(creds, "POST", `/payment_links/${encodeURIComponent(id)}/cancel`);
}

/** A cheap authenticated read: proves the key id/secret pair is valid before we store it. */
export async function verifyCredentials(creds: RazorpayCredentials): Promise<void> {
  await call(creds, "GET", "/payment_links?count=1");
}

/** Razorpay signs the raw webhook body with HMAC-SHA256 using the webhook secret. */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

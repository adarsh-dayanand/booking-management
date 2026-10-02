import { DateTime } from "luxon";
import { z } from "zod";
import type { ConsultationPricing, Service, Tenant } from "../types";

export type FeeBand = "flat" | "weekday" | "weekend" | "night";

export interface FeeQuote {
  amountPaise: number;
  band: FeeBand;
  hourlyRate: number;
}

const MIN_CHARGE_PAISE = 100; // Razorpay's minimum is ₹1

const rate = z
  .number()
  .min(0)
  .max(1_000_000)
  .refine((n) => Math.abs(n * 100 - Math.round(n * 100)) < 1e-6, "use at most 2 decimal places");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM (24h)");

export const pricingSchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("flat"), hourlyRate: rate }),
    z.object({
      mode: z.literal("variable"),
      weekdayRate: rate,
      weekendRate: rate,
      nightRate: rate,
      nightStart: hhmm.default("20:00"),
      nightEnd: hhmm.default("06:00"),
    }),
  ])
  .superRefine((p, ctx) => {
    if (p.mode === "variable" && p.nightStart === p.nightEnd) {
      ctx.addIssue({ code: "custom", message: "nightStart and nightEnd must differ", path: ["nightEnd"] });
    }
  });

const toMinutes = (hhmmValue: string): number => {
  const [h, m] = hhmmValue.split(":").map(Number);
  return h * 60 + m;
};

function inNightWindow(minuteOfDay: number, start: string, end: string): boolean {
  const s = toMinutes(start);
  const e = toMinutes(end);
  return s < e ? minuteOfDay >= s && minuteOfDay < e : minuteOfDay >= s || minuteOfDay < e;
}

/** Whether charging is actually on for this consultant: the admin enabled it AND the consultant turned it on with a rate card. */
export function paymentActive(tenant: Pick<Tenant, "paymentsEnabled" | "collectPayments" | "pricing">): boolean {
  return tenant.paymentsEnabled && tenant.collectPayments && tenant.pricing !== null;
}

/**
 * The fee for a consultation starting at `startAt`. The start time alone picks the band (a visit that runs past
 * the night boundary is not split), and the hourly rate is prorated by the service's duration.
 * Night wins over weekday/weekend; weekend means Saturday or Sunday in the clinic's timezone.
 */
export function quoteFee(pricing: ConsultationPricing, timezone: string, startAt: Date, service: Pick<Service, "durationMinutes">): FeeQuote {
  let band: FeeBand;
  let hourlyRate: number;
  if (pricing.mode === "flat") {
    band = "flat";
    hourlyRate = pricing.hourlyRate;
  } else {
    const local = DateTime.fromJSDate(startAt, { zone: timezone });
    if (inNightWindow(local.hour * 60 + local.minute, pricing.nightStart, pricing.nightEnd)) {
      band = "night";
      hourlyRate = pricing.nightRate;
    } else if (local.weekday >= 6) {
      band = "weekend";
      hourlyRate = pricing.weekendRate;
    } else {
      band = "weekday";
      hourlyRate = pricing.weekdayRate;
    }
  }
  const raw = Math.round((Math.round(hourlyRate * 100) * service.durationMinutes) / 60);
  const amountPaise = raw === 0 ? 0 : Math.max(MIN_CHARGE_PAISE, raw);
  return { amountPaise, band, hourlyRate };
}

export function formatRupees(amountPaise: number): string {
  const rupees = amountPaise / 100;
  return `₹${Number.isInteger(rupees) ? rupees : rupees.toFixed(2)}`;
}

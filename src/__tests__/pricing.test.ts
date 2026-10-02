import { describe, expect, it } from "vitest";
import { createHmac } from "crypto";
import { formatRupees, paymentActive, pricingSchema, quoteFee } from "../payments/pricing";
import { verifyWebhookSignature } from "../payments/razorpay";
import { appendPaymentLink, describeOutcome } from "../payments/offer";
import type { ConsultationPricing } from "../types";

const TZ = "Asia/Kolkata";
const half = { durationMinutes: 30 };
const hour = { durationMinutes: 60 };
// Oct 5 2026 is a Monday; 10th/11th are Saturday/Sunday. Times below are IST (+05:30).
const at = (iso: string) => new Date(`${iso}+05:30`);

const variable: ConsultationPricing = {
  mode: "variable", weekdayRate: 1000, weekendRate: 1500, nightRate: 2000, nightStart: "20:00", nightEnd: "06:00",
};

describe("flat hourly pricing", () => {
  const flat: ConsultationPricing = { mode: "flat", hourlyRate: 1000 };

  it("charges the same rate at any time, prorated by duration", () => {
    expect(quoteFee(flat, TZ, at("2026-10-05T10:00:00"), hour)).toEqual({ amountPaise: 100_000, band: "flat", hourlyRate: 1000 });
    expect(quoteFee(flat, TZ, at("2026-10-05T10:00:00"), half).amountPaise).toBe(50_000);
    expect(quoteFee(flat, TZ, at("2026-10-10T23:00:00"), half).amountPaise).toBe(50_000); // Saturday night: no surcharge
  });

  it("handles paise and rounds to the nearest paisa", () => {
    expect(quoteFee({ mode: "flat", hourlyRate: 333.33 }, TZ, at("2026-10-05T10:00:00"), { durationMinutes: 20 }).amountPaise).toBe(11_111);
  });

  it("a zero rate means free (no payment needed); tiny amounts are raised to Razorpay's ₹1 minimum", () => {
    expect(quoteFee({ mode: "flat", hourlyRate: 0 }, TZ, at("2026-10-05T10:00:00"), half).amountPaise).toBe(0);
    expect(quoteFee({ mode: "flat", hourlyRate: 1 }, TZ, at("2026-10-05T10:00:00"), { durationMinutes: 15 }).amountPaise).toBe(100);
  });
});

describe("variable pricing: weekday / weekend / night", () => {
  it("weekday daytime", () => {
    expect(quoteFee(variable, TZ, at("2026-10-05T10:00:00"), hour)).toMatchObject({ band: "weekday", amountPaise: 100_000 });
  });

  it("weekend daytime (Saturday and Sunday)", () => {
    expect(quoteFee(variable, TZ, at("2026-10-10T10:00:00"), hour)).toMatchObject({ band: "weekend", amountPaise: 150_000 });
    expect(quoteFee(variable, TZ, at("2026-10-11T10:00:00"), hour)).toMatchObject({ band: "weekend" });
  });

  it("night overrides both weekday and weekend", () => {
    expect(quoteFee(variable, TZ, at("2026-10-05T21:00:00"), hour)).toMatchObject({ band: "night", amountPaise: 200_000 });
    expect(quoteFee(variable, TZ, at("2026-10-10T21:00:00"), hour)).toMatchObject({ band: "night" });
  });

  it("the night window wraps midnight: starts inclusive at 20:00, ends exclusive at 06:00", () => {
    expect(quoteFee(variable, TZ, at("2026-10-05T19:59:00"), hour).band).toBe("weekday");
    expect(quoteFee(variable, TZ, at("2026-10-05T20:00:00"), hour).band).toBe("night");
    expect(quoteFee(variable, TZ, at("2026-10-06T02:00:00"), hour).band).toBe("night");
    expect(quoteFee(variable, TZ, at("2026-10-06T05:59:00"), hour).band).toBe("night");
    expect(quoteFee(variable, TZ, at("2026-10-06T06:00:00"), hour).band).toBe("weekday");
  });

  it("supports a same-day night window (e.g. 18:00-23:00)", () => {
    const p: ConsultationPricing = { ...variable, nightStart: "18:00", nightEnd: "23:00" };
    expect(quoteFee(p, TZ, at("2026-10-05T17:59:00"), hour).band).toBe("weekday");
    expect(quoteFee(p, TZ, at("2026-10-05T18:00:00"), hour).band).toBe("night");
    expect(quoteFee(p, TZ, at("2026-10-05T23:00:00"), hour).band).toBe("weekday");
  });

  it("uses the clinic's timezone, not UTC, to decide the band", () => {
    // 2026-10-10T20:00Z is Sunday 01:30 IST (night, weekend) but Saturday 20:00 UTC.
    expect(quoteFee(variable, TZ, new Date("2026-10-10T20:00:00Z"), hour).band).toBe("night");
    // 2026-10-09T23:00Z is Saturday 04:30 IST: still inside the night window
    expect(quoteFee(variable, TZ, new Date("2026-10-09T23:00:00Z"), hour).band).toBe("night");
    // 2026-10-10T01:00Z is Sat 06:30 IST: first daytime moment of Saturday -> weekend, not weekday
    expect(quoteFee(variable, TZ, new Date("2026-10-10T01:00:00Z"), hour).band).toBe("weekend");
  });
});

describe("pricing validation and activation", () => {
  it("accepts both modes and rejects bad input", () => {
    expect(pricingSchema.safeParse({ mode: "flat", hourlyRate: 500 }).success).toBe(true);
    expect(pricingSchema.parse({ mode: "variable", weekdayRate: 1, weekendRate: 2, nightRate: 3 })).toMatchObject({ nightStart: "20:00", nightEnd: "06:00" });
    expect(pricingSchema.safeParse({ mode: "flat", hourlyRate: -1 }).success).toBe(false);
    expect(pricingSchema.safeParse({ mode: "flat", hourlyRate: 10.123 }).success).toBe(false);
    expect(pricingSchema.safeParse({ mode: "variable", weekdayRate: 1, weekendRate: 2, nightRate: 3, nightStart: "8pm" }).success).toBe(false);
    expect(pricingSchema.safeParse({ mode: "variable", weekdayRate: 1, weekendRate: 2, nightRate: 3, nightStart: "20:00", nightEnd: "20:00" }).success).toBe(false);
    expect(pricingSchema.safeParse({ mode: "hourly", hourlyRate: 5 }).success).toBe(false);
  });

  it("payments are active only when the admin enabled them AND the clinic turned them on AND fees are set", () => {
    const flat: ConsultationPricing = { mode: "flat", hourlyRate: 100 };
    expect(paymentActive({ paymentsEnabled: true, collectPayments: true, pricing: flat })).toBe(true);
    expect(paymentActive({ paymentsEnabled: false, collectPayments: true, pricing: flat })).toBe(false); // admin hasn't enabled it
    expect(paymentActive({ paymentsEnabled: true, collectPayments: false, pricing: flat })).toBe(false);
    expect(paymentActive({ paymentsEnabled: true, collectPayments: true, pricing: null })).toBe(false);
  });

  it("formats rupees", () => {
    expect(formatRupees(50_000)).toBe("₹500");
    expect(formatRupees(12_550)).toBe("₹125.50");
  });
});

describe("Razorpay webhook signature", () => {
  const body = Buffer.from(JSON.stringify({ event: "payment_link.paid" }));
  const sign = (secret: string) => createHmac("sha256", secret).update(body).digest("hex");

  it("accepts a correct signature and rejects wrong, missing or malformed ones", () => {
    expect(verifyWebhookSignature(body, sign("whsec_12345678"), "whsec_12345678")).toBe(true);
    expect(verifyWebhookSignature(body, sign("other-secret"), "whsec_12345678")).toBe(false);
    expect(verifyWebhookSignature(body, undefined, "whsec_12345678")).toBe(false);
    expect(verifyWebhookSignature(body, "zz", "whsec_12345678")).toBe(false);
    expect(verifyWebhookSignature(Buffer.from("tampered"), sign("whsec_12345678"), "whsec_12345678")).toBe(false);
  });
});

describe("chat helpers", () => {
  const offer = { appointmentId: "a", url: "https://rzp.io/i/x", amountPaise: 50_000, amount: "₹500", expiresAt: new Date().toISOString() };

  it("puts the link in the text for WhatsApp unless the model already did", () => {
    expect(appendPaymentLink("Held for you.", offer)).toContain("https://rzp.io/i/x");
    expect(appendPaymentLink("Pay at https://rzp.io/i/x", offer)).toBe("Pay at https://rzp.io/i/x");
    expect(appendPaymentLink("hi", undefined)).toBe("hi");
  });

  it("describes the outcome only when it is final", () => {
    expect(describeOutcome({ paymentStatus: "created", appointmentStatus: "AWAITING_PAYMENT" })).toBeNull();
    expect(describeOutcome({ paymentStatus: "paid", appointmentStatus: "CONFIRMED" })).toContain("confirmed");
    expect(describeOutcome({ paymentStatus: "paid", appointmentStatus: "PENDING_CONFIRMATION" })).toContain("doctor");
    expect(describeOutcome({ paymentStatus: "expired", appointmentStatus: "CANCELLED" })).toContain("released");
  });
});

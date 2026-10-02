import { describe, expect, it } from "vitest";
import { computeCandidateSlots } from "../booking/booking";
import type { AvailabilityRule, Service, TenantConfig } from "../types";

function buildConfig(timezone: string, rules: AvailabilityRule[]): TenantConfig {
  return {
    tenant: {
      id: "t1",
      name: "Test Clinic",
      slug: "test",
      timezone,
      confirmationPolicy: "staff_approval",
      whatsappPhoneNumberId: null,
      staffWhatsappNumber: null,
      reminderHoursBefore: 24,
      faqText: null, paymentsEnabled: false, collectPayments: false, pricing: null,
    },
    services: [],
    resources: [],
    availabilityRules: rules,
  };
}

function rule(overrides: Partial<AvailabilityRule>): AvailabilityRule {
  return {
    id: "r1",
    tenantId: "t1",
    resourceId: "res1",
    weekday: null,
    specificDate: null,
    startTime: null,
    endTime: null,
    isClosed: false,
    ...overrides,
  };
}

const service: Service = { id: "s1", tenantId: "t1", name: "Consult", durationMinutes: 30, bufferMinutes: 0, active: true };

// 2026-09-28 is a Monday (weekday 1); used throughout as a known-good anchor date.
const MONDAY_START = new Date(Date.UTC(2026, 8, 28, 0, 0, 0));
const MONDAY_END = new Date(Date.UTC(2026, 8, 28, 23, 59, 59));
const FAR_PAST_NOW = new Date(Date.UTC(2026, 0, 1));

describe("computeCandidateSlots", () => {
  it("generates slots within weekday open hours in the tenant's timezone", () => {
    const config = buildConfig("Asia/Kolkata", [rule({ weekday: 1, startTime: "09:00", endTime: "10:00" })]);
    const slots = computeCandidateSlots(config, "res1", service, MONDAY_START, MONDAY_END, {
      minNoticeMinutes: 0,
      now: FAR_PAST_NOW,
    });
    // 09:00 IST = 03:30 UTC; a 30-min service fits at 09:00 and 09:30 within a 09:00-10:00 window.
    expect(slots.map((s) => s.startAt)).toEqual(["2026-09-28T03:30:00.000Z", "2026-09-28T04:00:00.000Z"]);
  });

  it("produces no slots on a day the weekly rule marks closed", () => {
    const config = buildConfig("Asia/Kolkata", [rule({ weekday: 1, isClosed: true })]);
    const slots = computeCandidateSlots(config, "res1", service, MONDAY_START, MONDAY_END, {
      minNoticeMinutes: 0,
      now: FAR_PAST_NOW,
    });
    expect(slots).toHaveLength(0);
  });

  it("lets a specific-date exception rule override the weekly rule", () => {
    const config = buildConfig("Asia/Kolkata", [
      rule({ weekday: 1, startTime: "09:00", endTime: "17:00" }),
      rule({ weekday: null, specificDate: "2026-09-28", isClosed: true }),
    ]);
    const slots = computeCandidateSlots(config, "res1", service, MONDAY_START, MONDAY_END, {
      minNoticeMinutes: 0,
      now: FAR_PAST_NOW,
    });
    expect(slots).toHaveLength(0);
  });

  it("drops candidates that violate minNoticeMinutes relative to `now`", () => {
    const config = buildConfig("Asia/Kolkata", [rule({ weekday: 1, startTime: "09:00", endTime: "10:00" })]);
    const now = new Date("2026-09-28T03:45:00.000Z"); // 09:15 IST
    const slots = computeCandidateSlots(config, "res1", service, MONDAY_START, MONDAY_END, {
      minNoticeMinutes: 30, // earliest allowed becomes 09:45 IST, too late for either 09:00 or 09:30
      now,
    });
    expect(slots).toHaveLength(0);
  });

  it("computes correct UTC offsets across a DST transition (America/New_York)", () => {
    const config = buildConfig("America/New_York", [rule({ weekday: 1, startTime: "09:00", endTime: "09:30" })]);
    // 2026-11-02 is the Monday right after DST ends (Nov 1, 2026) — EST (UTC-5) applies.
    const rangeStart = new Date(Date.UTC(2026, 10, 2));
    const rangeEnd = new Date(Date.UTC(2026, 10, 2, 23, 59, 59));
    const slots = computeCandidateSlots(config, "res1", service, rangeStart, rangeEnd, {
      minNoticeMinutes: 0,
      now: FAR_PAST_NOW,
    });
    expect(slots).toEqual([{ startAt: "2026-11-02T14:00:00.000Z", endAt: "2026-11-02T14:30:00.000Z" }]);
  });

  describe("start times follow the service (duration + buffer)", () => {
    const hours = [rule({ weekday: 1, startTime: "09:00", endTime: "10:00" })];
    const localTimes = (slots: { startAt: string }[]) => slots.map((s) => new Date(new Date(s.startAt).getTime() + 330 * 60_000).toISOString().slice(11, 16));
    const starts = (svc: Service, options = {}) =>
      localTimes(computeCandidateSlots(buildConfig("Asia/Kolkata", hours), "res1", svc, MONDAY_START, MONDAY_END, { minNoticeMinutes: 0, now: FAR_PAST_NOW, ...options }));

    it("steps by the visit length when there is no buffer, as long as the visit still fits before closing", () => {
      expect(starts(service)).toEqual(["09:00", "09:30"]);
      expect(starts({ ...service, durationMinutes: 15 })).toEqual(["09:00", "09:15", "09:30", "09:45"]);
    });

    it("steps by the visit plus its own buffer", () => {
      expect(starts({ ...service, durationMinutes: 20, bufferMinutes: 10 })).toEqual(["09:00", "09:30"]);
      expect(starts({ ...service, durationMinutes: 15, bufferMinutes: 5 })).toEqual(["09:00", "09:20", "09:40"]);
    });

    it("an explicit option still overrides the step", () => {
      expect(starts(service, { slotGranularityMinutes: 10 })).toEqual(["09:00", "09:10", "09:20", "09:30"]);
    });
  });
});

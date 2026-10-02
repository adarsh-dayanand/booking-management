import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const cancelAppointment = vi.fn();
const generateAvailableSlots = vi.fn();
const createAppointment = vi.fn();
const touchPatient = vi.fn();
const getPatientByPhone = vi.fn();
const updatePatientDetails = vi.fn();
const sendPhoneOtp = vi.fn();
const verifyPhoneOtp = vi.fn();
vi.mock("../lib/db", () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));
vi.mock("../booking/booking", async () => ({
  ...(await vi.importActual<typeof import("../booking/booking")>("../booking/booking")), // keep pure helpers such as openingWindowFor real
  cancelAppointment: (...a: unknown[]) => cancelAppointment(...a),
  generateAvailableSlots: (...a: unknown[]) => generateAvailableSlots(...a),
  createAppointment: (...a: unknown[]) => createAppointment(...a),
  rescheduleAppointment: vi.fn(),
}));
vi.mock("../booking/patients", () => ({
  touchPatient: (...a: unknown[]) => touchPatient(...a),
  getPatientByPhone: (...a: unknown[]) => getPatientByPhone(...a),
  updatePatientDetails: (...a: unknown[]) => updatePatientDetails(...a),
}));
vi.mock("../channels/phoneOtp", () => ({
  sendPhoneOtp: (...a: unknown[]) => sendPhoneOtp(...a),
  verifyPhoneOtp: (...a: unknown[]) => verifyPhoneOtp(...a),
}));
vi.mock("../channels/notify", () => ({ notifyStaff: vi.fn() }));
const diagnoseTime = vi.fn();
vi.mock("../booking/availability", async (orig) => ({ ...(await orig<typeof import("../booking/availability")>()), diagnoseTime: (...a: unknown[]) => diagnoseTime(...a) }));
const reconcileAppointment = vi.fn();
vi.mock("../payments/settlement", () => ({ reconcileAppointment: (...a: unknown[]) => reconcileAppointment(...a) }));
const getByAppointment = vi.fn();
vi.mock("../payments/store", () => ({ getByAppointment: (...a: unknown[]) => getByAppointment(...a) }));

import { executeTool, type AgentSession, type ToolContext } from "../chat/agentTools";

const APPT = "11111111-1111-4111-8111-111111111111";
const SERVICE = "22222222-2222-4222-8222-222222222222";
const RESOURCE = "33333333-3333-4333-8333-333333333333";

const ctx = (channel: "web" | "whatsapp", externalId: string, session: AgentSession = {}): ToolContext => ({
  config: {
    tenant: { id: "t1", name: "C", slug: "c", timezone: "UTC", confirmationPolicy: "instant", whatsappPhoneNumberId: null, staffWhatsappNumber: null, reminderHoursBefore: 24, faqText: null, slotIntervalMinutes: 5, paymentsEnabled: false, collectPayments: false, pricing: null },
    services: [{ id: SERVICE, tenantId: "t1", name: "Consult", durationMinutes: 30, bufferMinutes: 0, active: true }],
    resources: [{ id: RESOURCE, tenantId: "t1", name: "Doc", googleCalendarId: null, googleRefreshTokenEncrypted: null, googleConnectionStatus: "disconnected" as const, active: true }],
    availabilityRules: [],
  },
  channel,
  externalId,
  session,
});

const patient = (over: object = {}) => ({ id: "p1", name: "Asha Rao", phone: "+919876543210", phoneNormalized: "919876543210", phoneVerified: true, email: null, ...over });

beforeEach(() => {
  for (const m of [query, cancelAppointment, generateAvailableSlots, createAppointment, touchPatient, getPatientByPhone, updatePatientDetails, sendPhoneOtp, verifyPhoneOtp, reconcileAppointment, getByAppointment, diagnoseTime]) m.mockReset();
  diagnoseTime.mockImplementation(async (_c: unknown, _r: unknown, _s: unknown, start: Date) => ({ available: true, startAt: start.toISOString() }));
  touchPatient.mockResolvedValue(patient());
});

describe("ownership of appointments is tied to the verified phone", () => {
  it("won't cancel another patient's appointment on WhatsApp", async () => {
    query.mockResolvedValue({ rows: [] }); // no appointment with that id for this phone
    const r = await executeTool("cancel_appointment", { appointmentId: APPT }, ctx("whatsapp", "919876543210"));
    expect(r).toHaveProperty("error");
    expect(cancelAppointment).not.toHaveBeenCalled();
    expect(query.mock.calls[0][1]).toEqual([APPT, "t1", "919876543210"]);
  });

  it("cancels the patient's own appointment, attributed to the patient", async () => {
    query.mockResolvedValue({ rows: [{}] });
    cancelAppointment.mockResolvedValue({ id: APPT, status: "CANCELLED" });
    const r = await executeTool("cancel_appointment", { appointmentId: APPT, reason: "busy" }, ctx("whatsapp", "919876543210"));
    expect(r).toEqual({ appointmentId: APPT, status: "CANCELLED" });
    expect(cancelAppointment).toHaveBeenCalledWith(expect.anything(), APPT, "busy", "patient");
  });

  it("an unverified web visitor can't cancel or list anything", async () => {
    const c = ctx("web", "s1", { claimedPhone: "919876543210" });
    expect(await executeTool("cancel_appointment", { appointmentId: APPT }, c)).toMatchObject({ error: expect.stringContaining("isn't verified") });
    expect(await executeTool("find_my_appointments", {}, c)).toMatchObject({ error: expect.stringContaining("isn't verified") });
    expect(cancelAppointment).not.toHaveBeenCalled();
  });
});

describe("phone OTP authentication (web)", () => {
  it("send: captures the number as an unverified contact and remembers the claim", async () => {
    sendPhoneOtp.mockResolvedValue({ sent: true });
    const c = ctx("web", "s1");
    const r = await executeTool("send_phone_otp", { phone: "98765 43210" }, c);
    expect(r).toMatchObject({ sent: true });
    expect(touchPatient).toHaveBeenCalledWith("t1", "98765 43210", { channel: "web" });
    expect(c.session.claimedPhone).toBe("919876543210");
    expect(c.session.verifiedPhone).toBeUndefined();
  });

  it("send: in dev without WhatsApp the code is surfaced", async () => {
    sendPhoneOtp.mockResolvedValue({ sent: false, devCode: "123456", note: "dev" });
    expect(await executeTool("send_phone_otp", { phone: "9876543210" }, ctx("web", "s1"))).toMatchObject({ devCode: "123456" });
  });

  it("verify: binds the session to the number and marks the patient verified", async () => {
    verifyPhoneOtp.mockResolvedValue({ verified: true, phone: "919876543210" });
    const c = ctx("web", "s1");
    const r = await executeTool("verify_phone_otp", { phone: "9876543210", code: "123456" }, c);
    expect(r).toMatchObject({ verified: true, knownName: "Asha Rao" });
    expect(c.session.verifiedPhone).toBe("919876543210");
    expect(touchPatient).toHaveBeenCalledWith("t1", "919876543210", { channel: "web", verified: true });
  });

  it("verify: a wrong code binds nothing", async () => {
    verifyPhoneOtp.mockResolvedValue({ verified: false, error: "That code is incorrect." });
    const c = ctx("web", "s1");
    expect(await executeTool("verify_phone_otp", { phone: "9876543210", code: "000000" }, c)).toMatchObject({ verified: false });
    expect(c.session.verifiedPhone).toBeUndefined();
  });

  it("verify: after OTP the web visitor can manage their own appointment", async () => {
    query.mockResolvedValue({ rows: [{}] });
    cancelAppointment.mockResolvedValue({ id: APPT, status: "CANCELLED" });
    const r = await executeTool("cancel_appointment", { appointmentId: APPT }, ctx("web", "s1", { verifiedPhone: "919876543210" }));
    expect(r).toMatchObject({ status: "CANCELLED" });
  });
});

describe("capturing details without registration", () => {
  it("WhatsApp: saves volunteered details on the verified profile", async () => {
    updatePatientDetails.mockResolvedValue(patient({ email: "asha@example.com" }));
    const r = await executeTool("save_patient_details", { email: "asha@example.com", preferredLanguage: "Hindi" }, ctx("whatsapp", "919876543210"));
    expect(r).toMatchObject({ saved: ["email", "preferredLanguage"] });
    expect(updatePatientDetails).toHaveBeenCalledWith("t1", "p1", { email: "asha@example.com", preferredLanguage: "Hindi" });
  });

  it("web, unverified: can't overwrite a profile whose number is already verified", async () => {
    getPatientByPhone.mockResolvedValue(patient({ phoneVerified: true }));
    const r = await executeTool("save_patient_details", { email: "attacker@example.com" }, ctx("web", "s1", { claimedPhone: "919876543210" }));
    expect(r).toHaveProperty("error");
    expect(updatePatientDetails).not.toHaveBeenCalled();
  });

  it("web, unverified: may fill in a brand-new, unverified contact", async () => {
    getPatientByPhone.mockResolvedValue(null);
    touchPatient.mockResolvedValue(patient({ phoneVerified: false }));
    updatePatientDetails.mockResolvedValue(patient({ name: "Ravi" }));
    const r = await executeTool("save_patient_details", { name: "Ravi" }, ctx("web", "s1", { claimedPhone: "919000000000" }));
    expect(r).toMatchObject({ saved: ["name"] });
  });

  it("reads back the profile only for a verified identity", async () => {
    expect(await executeTool("get_my_profile", {}, ctx("web", "s1"))).toHaveProperty("error");
    expect(await executeTool("get_my_profile", {}, ctx("whatsapp", "919876543210"))).toMatchObject({ name: "Asha Rao" });
  });
});

describe("booking guards", () => {
  const args = { serviceId: SERVICE, practitionerId: RESOURCE, startAt: "2030-01-07T10:00:00.000Z" };
  const free = [{ startAt: "2030-01-07T10:00:00.000Z", endAt: "2030-01-07T10:30:00.000Z" }];

  it("refuses a time the engine doesn't offer (model-invented slot)", async () => {
    diagnoseTime.mockResolvedValue({ available: false, reason: "booked", message: "Doc already has an appointment then.", nearest: [] });
    const r = await executeTool("book_appointment", args, ctx("whatsapp", "919876543210"));
    expect(r).toHaveProperty("error");
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it("an unverified web visitor can't book", async () => {
    const r = await executeTool("book_appointment", { ...args, patientName: "Asha" }, ctx("web", "s1"));
    expect(r).toMatchObject({ error: expect.stringContaining("isn't verified") });
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it("books under the verified identity's number — a model-supplied phone is ignored — and reuses the saved name", async () => {
    generateAvailableSlots.mockResolvedValue(free);
    createAppointment.mockResolvedValue({ appointmentId: APPT, status: "PENDING_CONFIRMATION" });
    const r = await executeTool("book_appointment", { ...args, patientPhone: "5555555555" }, ctx("whatsapp", "919876543210"));
    const input = createAppointment.mock.calls[0][1];
    expect(input.patient).toEqual({ name: "Asha Rao", phone: "+919876543210" });
    expect(input.phoneVerified).toBe(true);
    expect(r).toMatchObject({ status: "PENDING_CONFIRMATION", meaning: expect.stringContaining("explicitly accept") });
  });

  it("asks for a name when the profile has none", async () => {
    touchPatient.mockResolvedValue(patient({ name: null }));
    expect(await executeTool("book_appointment", args, ctx("whatsapp", "919876543210"))).toMatchObject({ error: expect.stringContaining("name") });
  });

  it("returns validation problems to the model instead of throwing", async () => {
    expect(await executeTool("book_appointment", { serviceId: "nope", date: "2030-01-07", time: "10:00" }, ctx("whatsapp", "919876543210"))).toMatchObject({ error: expect.stringContaining('Unknown service "nope"') });
    expect(await executeTool("book_appointment", { date: "2030-01-07", time: "99:00" }, ctx("whatsapp", "919876543210"))).toMatchObject({ error: expect.stringContaining("Invalid arguments") });
    expect(createAppointment).not.toHaveBeenCalled();
  });
});

describe("payments in the chat", () => {
  const args = { serviceId: SERVICE, practitionerId: RESOURCE, startAt: "2030-01-07T10:00:00.000Z" };
  const offer = { appointmentId: APPT, url: "https://rzp.io/i/abc", amountPaise: 50_000, amount: "₹500", expiresAt: "2030-01-07T08:00:00.000Z" };

  it("a booking that needs payment is reported as NOT confirmed, with the link, and the link is queued for the patient", async () => {
    generateAvailableSlots.mockResolvedValue([{ startAt: args.startAt, endAt: "2030-01-07T10:30:00.000Z" }]);
    createAppointment.mockResolvedValue({ appointmentId: APPT, status: "AWAITING_PAYMENT", payment: offer });
    const c = { ...ctx("whatsapp", "919876543210"), outbox: {} as { payment?: typeof offer } };
    const r = await executeTool("book_appointment", args, c);
    expect(r).toMatchObject({ status: "AWAITING_PAYMENT", amount: "₹500", paymentUrl: offer.url, meaning: expect.stringContaining("NOT CONFIRMED") });
    expect(c.outbox.payment).toEqual(offer);
  });

  it("slots carry the fee only when payments are active for the clinic", async () => {
    const base = ctx("whatsapp", "919876543210");
    const withServices = (over: object) => ({
      ...base,
      config: {
        ...base.config,
        tenant: { ...base.config.tenant, ...over },
        services: [{ id: SERVICE, tenantId: "t1", name: "Consult", durationMinutes: 30, bufferMinutes: 0, active: true }],
        resources: [{ id: RESOURCE, tenantId: "t1", name: "Doc", googleCalendarId: null, googleRefreshTokenEncrypted: null, googleConnectionStatus: "disconnected" as const, active: true }],
      },
    });
    generateAvailableSlots.mockResolvedValue([{ startAt: "2099-01-07T10:00:00.000Z", endAt: "2099-01-07T10:30:00.000Z" }]);
    const slotArgs = { serviceId: SERVICE, fromDate: "2099-01-07", toDate: "2099-01-07" };

    const active = await executeTool("get_available_slots", slotArgs, withServices({ paymentsEnabled: true, collectPayments: true, pricing: { mode: "flat", hourlyRate: 1000 } }));
    expect((active as any).slots[0].fee).toBe("₹500");
    const inactive = await executeTool("get_available_slots", slotArgs, withServices({ paymentsEnabled: false, collectPayments: true, pricing: { mode: "flat", hourlyRate: 1000 } }));
    expect((inactive as any).slots[0]).not.toHaveProperty("fee");
  });

  it("check_payment_status only works on the patient's own appointment", async () => {
    query.mockResolvedValue({ rows: [] });
    const r = await executeTool("check_payment_status", { appointmentId: APPT }, ctx("whatsapp", "919876543210"));
    expect(r).toHaveProperty("error");
    expect(reconcileAppointment).not.toHaveBeenCalled();
  });

  it("check_payment_status reports a completed payment", async () => {
    query.mockResolvedValue({ rows: [{}] });
    reconcileAppointment.mockResolvedValue({ paymentStatus: "paid", appointmentStatus: "CONFIRMED" });
    const r = await executeTool("check_payment_status", { appointmentId: APPT }, ctx("whatsapp", "919876543210"));
    expect(r).toMatchObject({ paymentStatus: "paid", meaning: expect.stringContaining("confirmed") });
  });

  it("check_payment_status hands back the link while still unpaid", async () => {
    query.mockResolvedValue({ rows: [{}] });
    reconcileAppointment.mockResolvedValue({ paymentStatus: "created", appointmentStatus: "AWAITING_PAYMENT" });
    getByAppointment.mockResolvedValue({ appointmentId: APPT, linkUrl: offer.url, amountPaise: 50_000, expiresAt: new Date("2030-01-07T08:00:00.000Z") });
    const c = { ...ctx("whatsapp", "919876543210"), outbox: {} as { payment?: typeof offer } };
    const r = await executeTool("check_payment_status", { appointmentId: APPT }, c);
    expect(r).toMatchObject({ paymentStatus: "unpaid", paymentUrl: offer.url });
    expect(c.outbox.payment?.url).toBe(offer.url);
  });
});

describe("offering times when slots are 5 minutes apart", () => {
  const base = ctx("whatsapp", "919876543210");
  const withServices = {
    ...base,
    config: {
      ...base.config,
      tenant: { ...base.config.tenant, timezone: "Asia/Kolkata" },
      services: [{ id: SERVICE, tenantId: "t1", name: "Consult", durationMinutes: 30, bufferMinutes: 0, active: true }],
      resources: [{ id: RESOURCE, tenantId: "t1", name: "Doc", googleCalendarId: null, googleRefreshTokenEncrypted: null, googleConnectionStatus: "disconnected" as const, active: true }],
    },
  };
  // every 5 minutes, 09:00-16:30 IST on one far-future day
  const daySlots = Array.from({ length: 91 }, (_, i) => {
    const t = Date.parse("2099-01-07T09:00:00+05:30") + i * 5 * 60_000;
    return { startAt: new Date(t).toISOString(), endAt: new Date(t + 30 * 60_000).toISOString() };
  });
  const args = { serviceId: SERVICE, fromDate: "2099-01-07", toDate: "2099-01-07" };
  const times = (r: any) => r.slots.map((s: any) => s.local.split(", ")[1]);

  it("spreads the offered times over the day instead of listing the first few minutes", async () => {
    generateAvailableSlots.mockResolvedValue(daySlots);
    const r = await executeTool("get_available_slots", args, withServices);
    expect(r.slots).toHaveLength(8);
    expect(times(r)[0]).toBe("9:00 AM");
    expect(times(r).at(-1)).toBe("4:30 PM");
  });

  it("returns the times nearest to a requested time of day", async () => {
    generateAvailableSlots.mockResolvedValue(daySlots);
    const r = await executeTool("get_available_slots", { ...args, nearTime: "13:00" }, withServices);
    // spaced 15 minutes apart so they are real choices, not eight neighbouring minutes
    expect(times(r)).toEqual(["12:00 PM", "12:15 PM", "12:30 PM", "12:45 PM", "1:00 PM", "1:15 PM", "1:30 PM", "1:45 PM"]);
  });

  it("rejects a malformed nearTime", async () => {
    expect(await executeTool("get_available_slots", { ...args, nearTime: "5pm" }, withServices)).toMatchObject({ error: expect.stringContaining("Invalid arguments") });
  });
});

describe("times: the clinic's zone, not the model's guess", () => {
  const kolkata = (channel: "web" | "whatsapp" = "whatsapp") => {
    const c = ctx(channel, "919876543210");
    return { ...c, config: { ...c.config, tenant: { ...c.config.tenant, timezone: "Asia/Kolkata" } } };
  };
  const base = { serviceId: SERVICE, practitionerId: RESOURCE };
  const booked = () => createAppointment.mock.calls[0][1].startAt.toISOString();

  it("books 1:30 PM on a date as clinic time: 13:30 IST is 08:00 UTC", async () => {
    createAppointment.mockResolvedValue({ appointmentId: APPT, status: "CONFIRMED" });
    const r = await executeTool("book_appointment", { ...base, date: "2030-01-07", time: "13:30" }, kolkata());
    expect(r).toMatchObject({ status: "CONFIRMED", when: "Mon 07 Jan 2030, 1:30 PM" });
    expect(booked()).toBe("2030-01-07T08:00:00.000Z");
  });

  it("reads an offset-less startAt as clinic time, not UTC (the usual way a model gets it wrong)", async () => {
    createAppointment.mockResolvedValue({ appointmentId: APPT, status: "CONFIRMED" });
    await executeTool("book_appointment", { ...base, startAt: "2030-01-07T13:30:00" }, kolkata());
    expect(booked()).toBe("2030-01-07T08:00:00.000Z");
  });

  it("keeps an explicit offset or Z exactly as given", async () => {
    createAppointment.mockResolvedValue({ appointmentId: APPT, status: "CONFIRMED" });
    await executeTool("book_appointment", { ...base, startAt: "2030-01-07T13:30:00+05:30" }, kolkata());
    expect(booked()).toBe("2030-01-07T08:00:00.000Z");
    createAppointment.mockClear();
    await executeTool("book_appointment", { ...base, startAt: "2030-01-07T08:00:00.000Z" }, kolkata());
    expect(booked()).toBe("2030-01-07T08:00:00.000Z");
  });

  it("asks for a complete, valid time instead of guessing", async () => {
    for (const bad of [{}, { date: "2030-01-07" }, { time: "13:30" }, { date: "2030-02-31", time: "10:00" }]) {
      expect(await executeTool("book_appointment", { ...base, ...bad }, kolkata())).toHaveProperty("error");
    }
    expect(await executeTool("book_appointment", { ...base, date: "2030-01-07", time: "25:00" }, kolkata())).toMatchObject({ error: expect.stringContaining("Invalid arguments") });
    expect(createAppointment).not.toHaveBeenCalled();
  });

  it("checks the clinic-local instant against availability", async () => {
    createAppointment.mockResolvedValue({ appointmentId: APPT, status: "CONFIRMED" });
    await executeTool("book_appointment", { ...base, date: "2030-01-07", time: "13:30" }, kolkata());
    expect(diagnoseTime.mock.calls[0][3].toISOString()).toBe("2030-01-07T08:00:00.000Z");
  });

  it("when a time can't be booked, says why and offers the nearest free times — never a bare 'no longer available'", async () => {
    diagnoseTime.mockResolvedValue({
      available: false, reason: "outside_hours", message: "Mon 7 Jan, 8:30 AM is outside Doc's hours that day (9:00 AM to 5:00 PM).",
      nearest: [{ startAt: "2030-01-07T03:30:00.000Z", endAt: "2030-01-07T04:00:00.000Z" }, { startAt: "2030-01-07T03:35:00.000Z", endAt: "2030-01-07T04:05:00.000Z" }],
    });
    const r: any = await executeTool("book_appointment", { ...base, date: "2030-01-07", time: "08:30" }, kolkata());
    expect(createAppointment).not.toHaveBeenCalled();
    expect(r).toMatchObject({ available: false, reason: "outside_hours", error: expect.stringContaining("outside Doc's hours") });
    expect(r.error).not.toMatch(/no longer available/i);
    expect(r.nearestFreeTimes).toEqual([
      expect.objectContaining({ date: "2030-01-07", time: "09:00", local: "Mon 07 Jan 2030, 9:00 AM" }),
      expect.objectContaining({ date: "2030-01-07", time: "09:05" }),
    ]);
  });

  it("a race lost at the database is reported as 'booked' with a pointer to fresh options", async () => {
    const { SlotConflictError } = await import("../errors");
    createAppointment.mockRejectedValue(new SlotConflictError());
    expect(await executeTool("book_appointment", { ...base, date: "2030-01-07", time: "13:30" }, kolkata())).toMatchObject({ available: false, reason: "booked" });
  });

  it("rejects a service or practitioner that isn't this clinic's", async () => {
    const other = "99999999-9999-4999-8999-999999999999";
    expect(await executeTool("book_appointment", { serviceId: other, practitionerId: RESOURCE, date: "2030-01-07", time: "10:00" }, kolkata())).toMatchObject({ error: expect.stringContaining("Unknown service") });
    expect(await executeTool("book_appointment", { serviceId: SERVICE, practitionerId: other, date: "2030-01-07", time: "10:00" }, kolkata())).toMatchObject({ error: expect.stringContaining("Unknown practitioner") });
    expect(diagnoseTime).not.toHaveBeenCalled();
  });
});

describe("check_time: answering 'is 1:30 PM free?' without guessing from a sample", () => {
  const c = () => { const x = ctx("whatsapp", "919876543210"); return { ...x, config: { ...x.config, tenant: { ...x.config.tenant, timezone: "Asia/Kolkata" } } }; };
  const args = { serviceId: SERVICE, practitionerId: RESOURCE, date: "2030-01-07", time: "13:30" };

  it("confirms a free time, with the instant and how to say it", async () => {
    expect(await executeTool("check_time", args, c())).toEqual({
      available: true, startAt: "2030-01-07T08:00:00.000Z", local: "Mon 07 Jan 2030, 1:30 PM", spoken: "Monday 7 January at 1:30 PM",
    });
  });

  it("explains an unavailable time with the reason and alternatives", async () => {
    diagnoseTime.mockResolvedValue({ available: false, reason: "booked", message: "Doc already has an appointment then.", nearest: [{ startAt: "2030-01-07T08:30:00.000Z", endAt: "2030-01-07T09:00:00.000Z" }] });
    const r: any = await executeTool("check_time", args, c());
    expect(r).toMatchObject({ available: false, reason: "booked" });
    expect(r.nearestFreeTimes[0]).toMatchObject({ time: "14:00", local: "Mon 07 Jan 2030, 2:00 PM" });
  });

  it("needs a real date and a 24-hour time", async () => {
    expect(await executeTool("check_time", { ...args, time: "1:30 PM" }, c())).toMatchObject({ error: expect.stringContaining("Invalid arguments") });
  });
});

describe("get_available_slots shows the whole picture, not just a sample", () => {
  const base = ctx("whatsapp", "919876543210");
  const config = { ...base.config, tenant: { ...base.config.tenant, timezone: "Asia/Kolkata", slotIntervalMinutes: 5 } };
  const slot = (iso: string) => ({ startAt: new Date(iso).toISOString(), endAt: new Date(Date.parse(iso) + 30 * 60_000).toISOString() });
  const every5 = (from: string, count: number) => Array.from({ length: count }, (_, i) => slot(new Date(Date.parse(from) + i * 5 * 60_000).toISOString()));
  const args = { serviceId: SERVICE, fromDate: "2099-01-07", toDate: "2099-01-07" };

  it("lists every free range so an unlisted time isn't mistaken for a booked one", async () => {
    // free 9:00–11:55 and 1:00 PM–4:30 PM IST; 12:00–12:55 is taken
    generateAvailableSlots.mockResolvedValue([...every5("2099-01-07T09:00:00+05:30", 36), ...every5("2099-01-07T13:00:00+05:30", 43)]);
    const r: any = await executeTool("get_available_slots", args, { ...base, config });
    expect(r.ranges).toEqual([
      { practitioner: "Doc", date: "2099-01-07", day: "Wed 7 Jan", from: "9:00 AM", to: "11:55 AM" },
      { practitioner: "Doc", date: "2099-01-07", day: "Wed 7 Jan", from: "1:00 PM", to: "4:30 PM" },
    ]);
    expect(r.intervalMinutes).toBe(5);
    expect(r.note).toContain("only a sample");
    expect(r.slots.length).toBeLessThanOrEqual(8); // the sample is small…
    expect(r.slots.map((s: any) => s.local.split(", ")[1])).not.toContain("1:30 PM"); // …so 1:30 PM may not be in it, yet it is inside a range
  });

  it("splits ranges where times are taken in the middle", async () => {
    generateAvailableSlots.mockResolvedValue([...every5("2099-01-07T09:00:00+05:30", 4), ...every5("2099-01-07T10:00:00+05:30", 3)]);
    const r: any = await executeTool("get_available_slots", args, { ...base, config });
    expect(r.ranges.map((x: any) => `${x.from}-${x.to}`)).toEqual(["9:00 AM-9:15 AM", "10:00 AM-10:10 AM"]);
  });

  it("uses the clinic's interval when merging", async () => {
    const slots = [0, 20, 40, 60].map((m) => slot(new Date(Date.parse("2099-01-07T09:00:00+05:30") + m * 60_000).toISOString()));
    generateAvailableSlots.mockResolvedValue(slots);
    const r: any = await executeTool("get_available_slots", args, { ...base, config: { ...config, tenant: { ...config.tenant, slotIntervalMinutes: 20 } } });
    expect(r.ranges).toHaveLength(1);
    expect(r.ranges[0]).toMatchObject({ from: "9:00 AM", to: "10:00 AM" });
  });
});

describe("rescheduling uses the same time handling", () => {
  it("moves to a clinic-local date and time, or explains why not", async () => {
    const c = ctx("whatsapp", "919876543210");
    const kol = { ...c, config: { ...c.config, tenant: { ...c.config.tenant, timezone: "Asia/Kolkata" } } };
    query.mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({ rows: [{ service_id: SERVICE, resource_id: RESOURCE }] });
    const { rescheduleAppointment } = await import("../booking/booking");
    (rescheduleAppointment as any).mockResolvedValue({ id: APPT, status: "CONFIRMED" });
    const r = await executeTool("reschedule_appointment", { appointmentId: APPT, date: "2030-01-08", time: "16:45" }, kol);
    expect(r).toMatchObject({ status: "CONFIRMED", when: "Tue 08 Jan 2030, 4:45 PM" });
    expect((rescheduleAppointment as any).mock.calls.at(-1)[2].toISOString()).toBe("2030-01-08T11:15:00.000Z");
  });
});

describe("which service and practitioner: ids can be omitted, named, or must be asked for", () => {
  const kol = () => { const c = ctx("whatsapp", "919876543210"); return { ...c, config: { ...c.config, tenant: { ...c.config.tenant, timezone: "Asia/Kolkata" } } }; };
  const when = { date: "2030-01-07", time: "13:30" };

  it("a clinic with one service and one practitioner needs no ids", async () => {
    const r: any = await executeTool("check_time", when, kol());
    expect(r).toMatchObject({ available: true });
    expect(diagnoseTime.mock.calls[0].slice(1, 3)).toEqual([RESOURCE, SERVICE]);
  });

  it("accepts the exact name instead of an id (case-insensitive)", async () => {
    await executeTool("check_time", { ...when, serviceId: "consult", practitionerId: "DOC" }, kol());
    expect(diagnoseTime.mock.calls[0].slice(1, 3)).toEqual([RESOURCE, SERVICE]);
  });

  it("says what to do — not 'Invalid uuid' — when it can't tell", async () => {
    const c = kol();
    const two = { ...c, config: { ...c.config, services: [...c.config.services, { ...c.config.services[0], id: "44444444-4444-4444-8444-444444444444", name: "Cleaning" }] } };
    expect(await executeTool("check_time", when, two)).toMatchObject({ error: "Which service? Call list_services and use one of its ids." });
    expect(await executeTool("check_time", { ...when, serviceId: "Root canal" }, kol())).toMatchObject({ error: 'Unknown service "Root canal". Use an id from list_services.' });
    expect(diagnoseTime).not.toHaveBeenCalled();
  });

  it("ignores turned-off services", async () => {
    const c = kol();
    const off = { ...c, config: { ...c.config, services: [{ ...c.config.services[0], active: false }] } };
    expect(await executeTool("check_time", when, off)).toMatchObject({ error: "This clinic has no service set up." });
  });
});

describe("an empty day is explained, and the searched range is stated", () => {
  const base = ctx("whatsapp", "919876543210");
  const mk = (rules: object[]) => ({ ...base, config: { ...base.config, tenant: { ...base.config.tenant, timezone: "Asia/Kolkata" }, availabilityRules: rules as never } });
  const MONDAY_RULE = { id: "r", tenantId: "t1", resourceId: RESOURCE, weekday: 1, specificDate: null, startTime: "09:00:00", endTime: "17:00:00", isClosed: false };

  it("a closed day is reported as closed — not as booked", async () => {
    generateAvailableSlots.mockResolvedValue([]);
    // 2099-01-10 is a Saturday; the clinic only works Mondays here
    const r: any = await executeTool("get_available_slots", { serviceId: SERVICE, fromDate: "2099-01-10", toDate: "2099-01-10" }, mk([MONDAY_RULE]));
    expect(r.slots).toEqual([]);
    expect(r.searched).toEqual({ from: "2099-01-10", to: "2099-01-10" });
    expect(r.note).toContain("Doc isn't working on Saturday 10 Jan");
  });

  it("a working day with nothing left is reported as full", async () => {
    generateAvailableSlots.mockResolvedValue([]);
    const r: any = await executeTool("get_available_slots", { serviceId: SERVICE, fromDate: "2099-01-12", toDate: "2099-01-12" }, mk([MONDAY_RULE])); // a Monday
    expect(r.note).toContain("Doc works Monday 12 Jan but has no free time left then");
  });

  it("results say which dates were searched, so they can't be attributed to another day", async () => {
    generateAvailableSlots.mockResolvedValue([{ startAt: "2099-01-12T04:00:00.000Z", endAt: "2099-01-12T04:30:00.000Z" }]);
    const r: any = await executeTool("get_available_slots", { serviceId: SERVICE, fromDate: "2099-01-10", toDate: "2099-01-14" }, mk([MONDAY_RULE]));
    expect(r.searched).toEqual({ from: "2099-01-10", to: "2099-01-14" });
  });
});

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
vi.mock("../booking/booking", () => ({
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
    services: [], resources: [], availabilityRules: [],
  },
  channel,
  externalId,
  session,
});

const patient = (over: object = {}) => ({ id: "p1", name: "Asha Rao", phone: "+919876543210", phoneNormalized: "919876543210", phoneVerified: true, email: null, ...over });

beforeEach(() => {
  for (const m of [query, cancelAppointment, generateAvailableSlots, createAppointment, touchPatient, getPatientByPhone, updatePatientDetails, sendPhoneOtp, verifyPhoneOtp, reconcileAppointment, getByAppointment]) m.mockReset();
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
    generateAvailableSlots.mockResolvedValue([{ startAt: "2030-01-07T11:00:00.000Z", endAt: "2030-01-07T11:30:00.000Z" }]);
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
    expect(await executeTool("book_appointment", { serviceId: "nope" }, ctx("whatsapp", "919876543210"))).toMatchObject({ error: expect.stringContaining("Invalid arguments") });
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
  const times = (r: any) => r.slots.map((s: any) => s.local.slice(-5));

  it("spreads the offered times over the day instead of listing the first few minutes", async () => {
    generateAvailableSlots.mockResolvedValue(daySlots);
    const r = await executeTool("get_available_slots", args, withServices);
    expect(r.slots).toHaveLength(8);
    expect(times(r)[0]).toBe("09:00");
    expect(times(r).at(-1)).toBe("16:30");
  });

  it("returns the times nearest to a requested time of day", async () => {
    generateAvailableSlots.mockResolvedValue(daySlots);
    const r = await executeTool("get_available_slots", { ...args, nearTime: "13:00" }, withServices);
    expect(times(r)).toEqual(["12:40", "12:45", "12:50", "12:55", "13:00", "13:05", "13:10", "13:15"]);
  });

  it("rejects a malformed nearTime", async () => {
    expect(await executeTool("get_available_slots", { ...args, nearTime: "5pm" }, withServices)).toMatchObject({ error: expect.stringContaining("Invalid arguments") });
  });
});

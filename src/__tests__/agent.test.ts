import { beforeEach, describe, expect, it, vi } from "vitest";

const generate = vi.fn();
const executeTool = vi.fn();
vi.mock("../chat/gemini", async (orig) => ({ ...(await orig<typeof import("../chat/gemini")>()), generate: (...a: unknown[]) => generate(...a) }));
vi.mock("../chat/agentTools", () => ({
  toolDeclarations: [],
  isWriteTool: (n: string) => n === "book_appointment",
  executeTool: (...a: unknown[]) => executeTool(...a),
}));

import { DateTime } from "luxon";
import { buildSystemPrompt, runTurn } from "../chat/agent";
import type { TenantConfig } from "../types";

const config = (policy: "instant" | "staff_approval"): TenantConfig => ({
  tenant: {
    id: "t1", name: "Demo Clinic", slug: "demo", timezone: "Asia/Kolkata", confirmationPolicy: policy,
    whatsappPhoneNumberId: null, staffWhatsappNumber: null, reminderHoursBefore: 24, faqText: "Open Mon-Fri 9-5.", slotIntervalMinutes: 5, paymentsEnabled: false, collectPayments: false, pricing: null,
  },
  services: [], resources: [], availabilityRules: [],
});
const ctx = (c: TenantConfig) => ({ config: c, channel: "whatsapp" as const, externalId: "919876543210", session: {} });
const text = (t: string) => ({ candidates: [{ content: { role: "model", parts: [{ text: t }] } }] });
const call = (name: string, args: object) => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] } }] });

beforeEach(() => {
  generate.mockReset();
  executeTool.mockReset();
});

describe("system prompt reflects the configured flow", () => {
  it("direct booking: confirmed immediately", () => {
    expect(buildSystemPrompt(config("instant"))).toContain("CONFIRMED immediately");
  });
  it("doctor approval: request until explicitly accepted", () => {
    const p = buildSystemPrompt(config("staff_approval"));
    expect(p).toContain("explicitly accepts");
    expect(p).toContain("Never say it is confirmed");
  });
  it("mentions payments only when the clinic actually collects them", () => {
    const off = buildSystemPrompt(config("instant"));
    expect(off).not.toContain("PAYMENTS");
    const c = config("instant");
    const on = buildSystemPrompt({ ...c, tenant: { ...c.tenant, paymentsEnabled: true, collectPayments: true, pricing: { mode: "flat", hourlyRate: 500 } } });
    expect(on).toContain("PAYMENTS");
    expect(on).toContain("AWAITING_PAYMENT");
    const platformOff = buildSystemPrompt({ ...c, tenant: { ...c.tenant, paymentsEnabled: false, collectPayments: true, pricing: { mode: "flat", hourlyRate: 500 } } });
    expect(platformOff).not.toContain("PAYMENTS");
  });
  describe("time understanding", () => {
    const now = DateTime.fromISO("2026-10-02T13:40:00", { zone: "Asia/Kolkata" }); // a Friday
    const prompt = () => buildSystemPrompt(config("instant"), now);

    it("states the clinic's current time in 12-hour form and its zone", () => {
      expect(prompt()).toContain("Friday, 2 October 2026, 1:40 PM");
      expect(prompt()).toContain("Asia/Kolkata");
    });

    it("gives a ready-made calendar so weekday arithmetic is a lookup", () => {
      const p = prompt();
      expect(p).toContain("today = Fri 2 Oct (2026-10-02)");
      expect(p).toContain("tomorrow = Sat 3 Oct (2026-10-03)");
      expect(p).toContain("Monday = Mon 5 Oct (2026-10-05)");
      expect(p).toContain("Friday = Fri 16 Oct (2026-10-16)"); // the 15-day window reaches the Friday after next
    });

    it("tells the model how to read spoken times and never to convert zones", () => {
      const p = prompt();
      expect(p).toContain('"1:30 PM"');
      expect(p).toContain("13:30");
      expect(p).toContain("half past one");
      expect(p).toContain("Never convert to UTC");
      expect(p).toContain("24-hour HH:MM");
    });

    it("forbids deciding a time is booked from the sample, and contradicting itself", () => {
      const p = prompt();
      expect(p).toContain("check_time");
      expect(p).toContain("SAMPLE");
      expect(p).toContain("Say a time is unavailable only if a tool said so");
      expect(p).toContain("Never offer a time and call it unavailable in the same message");
    });
  });

  it("includes clinic FAQ text", () => {
    expect(buildSystemPrompt(config("instant"))).toContain("Open Mon-Fri 9-5.");
  });
});

describe("system prompt: who the patient is", () => {
  const patient = (over: object = {}) => ({
    id: "p1", tenantId: "t1", name: "Asha K", nameSource: "whatsapp_profile" as const, phone: "+919876543210", phoneNormalized: "919876543210",
    phoneVerified: true, email: null, dateOfBirth: null, preferredLanguage: null, firstChannel: "whatsapp" as const,
    firstSeenAt: new Date(Date.now() - 86_400_000).toISOString(), lastSeenAt: new Date().toISOString(), ...over,
  });

  it("WhatsApp: verified number, flags a profile-derived name as unconfirmed", () => {
    const p = buildSystemPrompt(config("instant"), undefined, { channel: "whatsapp", patient: patient(), verified: true });
    expect(p).toContain("+919876543210");
    expect(p).toContain("VERIFIED");
    expect(p).toContain("may not be their real name");
    expect(p).toContain("returning patient");
  });
  it("shows a patient-stated name and saved details without asking again", () => {
    const p = buildSystemPrompt(config("instant"), undefined, {
      channel: "whatsapp", patient: patient({ nameSource: "patient", email: "asha@example.com", preferredLanguage: "Kannada" }), verified: true,
    });
    expect(p).toContain("Saved name: Asha K.");
    expect(p).toContain("asha@example.com");
    expect(p).toContain("Kannada");
  });
  it("web, unverified: reveals nothing stored about the number", () => {
    const p = buildSystemPrompt(config("instant"), undefined, { channel: "web", patient: patient({ email: "secret@example.com" }), verified: false, claimedPhone: "919876543210" });
    expect(p).toContain("NOT verified");
    expect(p).not.toContain("secret@example.com");
    expect(p).not.toContain("Asha K");
  });
  it("tells the agent there is no registration and to save volunteered details", () => {
    const p = buildSystemPrompt(config("instant"));
    expect(p).toContain("there is no registration");
    expect(p).toContain("save_patient_details");
  });
});

describe("runTurn tool loop", () => {
  it("runs requested tools, feeds results back, and returns the final text", async () => {
    generate.mockResolvedValueOnce(call("list_services", {})).mockResolvedValueOnce(text("We offer Consultation."));
    executeTool.mockResolvedValue({ services: [{ id: "s1", name: "Consultation" }] });
    const c = config("instant");
    const result = await runTurn(c, ctx(c), [], "what do you offer?");
    expect(result).toEqual({ text: "We offer Consultation.", wroteSomething: false });
    expect(executeTool).toHaveBeenCalledWith("list_services", {}, expect.anything());
    const secondRequest = generate.mock.calls[1][0];
    expect(secondRequest.contents.at(-1).parts[0].functionResponse.name).toBe("list_services");
  });

  it("flags completed writes so a later failure can't cause a repeat", async () => {
    generate.mockResolvedValueOnce(call("book_appointment", {})).mockRejectedValueOnce(new Error("boom"));
    executeTool.mockResolvedValue({ appointmentId: "x" });
    const c = config("instant");
    await expect(runTurn(c, ctx(c), [], "book it")).rejects.toMatchObject({ wroteSomething: true });
  });

  it("does not count failed writes", async () => {
    generate.mockResolvedValueOnce(call("book_appointment", {})).mockResolvedValueOnce(text("That time is gone."));
    executeTool.mockResolvedValue({ error: "no longer available" });
    const c = config("instant");
    expect((await runTurn(c, ctx(c), [], "book it")).wroteSomething).toBe(false);
  });

  it("stops after too many tool steps", async () => {
    generate.mockResolvedValue(call("list_services", {}));
    executeTool.mockResolvedValue({});
    const c = config("instant");
    await expect(runTurn(c, ctx(c), [], "loop")).rejects.toThrow("Too many tool steps");
    expect(generate).toHaveBeenCalledTimes(6);
  });
});

describe("a transient model failure doesn't lose the patient's reply", () => {
  const c = config("instant");
  const empty = { candidates: [{ content: undefined, finishReason: "OTHER" }] };

  it("retries once after an empty model response", async () => {
    generate.mockResolvedValueOnce(empty).mockResolvedValueOnce(text("Hello, how can I help?"));
    const r = await runTurn(c, ctx(c), [], "hi");
    expect(r.text).toBe("Hello, how can I help?");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("retries after a 503, and after a reply with no text", async () => {
    const { GeminiError } = await import("../chat/gemini");
    generate.mockRejectedValueOnce(new GeminiError("Gemini request failed (503): overloaded")).mockResolvedValueOnce({ candidates: [{ content: { role: "model", parts: [{ text: "", thought: true }] } }] }).mockResolvedValueOnce(text("ok"));
    // 503 → retried (attempt 2: a thoughts-only reply, which counts as empty → but that was already the one retry) so this surfaces
    await expect(runTurn(c, ctx(c), [], "hi")).rejects.toThrow("Model returned no text");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("gives up after one retry", async () => {
    generate.mockResolvedValue(empty);
    await expect(runTurn(c, ctx(c), [], "hi")).rejects.toThrow("Empty model response");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("does not retry a real error such as a bad request", async () => {
    const { GeminiError } = await import("../chat/gemini");
    generate.mockRejectedValue(new GeminiError("Gemini request failed (400): invalid argument"));
    await expect(runTurn(c, ctx(c), [], "hi")).rejects.toThrow("(400)");
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("retries a timeout, and tools run only once across the retry", async () => {
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    executeTool.mockResolvedValue({ ok: true });
    generate.mockResolvedValueOnce(call("list_services", {})).mockRejectedValueOnce(timeout).mockResolvedValueOnce(text("Here you go"));
    const r = await runTurn(c, ctx(c), [], "what services?");
    expect(r.text).toBe("Here you go");
    expect(executeTool).toHaveBeenCalledTimes(1); // the failed model call was retried, the tool was not re-run
  });
});

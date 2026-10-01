import { describe, expect, it } from "vitest";
import { patientMessage, staffMessage, type NotifyContext } from "../channels/notify";

const base: NotifyContext = {
  ref: "a1b2c3",
  status: "PENDING_CONFIRMATION",
  channel: "web",
  patientName: "Asha",
  patientPhone: "+919876543210",
  serviceName: "Consultation",
  resourceName: "Dr. Rao",
  clinicName: "Demo Clinic",
  when: "Tue 06 Oct 2026, 14:30",
};

describe("doctor-approval flow messages", () => {
  it("asks the doctor to explicitly accept and tells them how", () => {
    const msg = staffMessage("created", "patient", base)!;
    expect(msg).toContain("APPROVE a1b2c3");
    expect(msg).toContain("REJECT a1b2c3");
  });
  it("tells a web patient it is only a request until accepted", () => {
    expect(patientMessage("created", "patient", base)).toContain("confirm it shortly");
  });
  it("notifies the patient on accept and reject", () => {
    expect(patientMessage("approved", "staff", { ...base, status: "CONFIRMED" })).toContain("has confirmed");
    expect(patientMessage("rejected", "staff", { ...base, status: "REJECTED", reason: "on leave" })).toContain("on leave");
  });
});

describe("direct-booking flow messages", () => {
  const confirmed = { ...base, status: "CONFIRMED" };
  it("only FYIs the doctor, no approve prompt", () => {
    const msg = staffMessage("created", "patient", confirmed)!;
    expect(msg).toContain("auto-confirmed");
    expect(msg).not.toContain("APPROVE");
  });
  it("does not double-message WhatsApp patients the agent already replied to", () => {
    expect(patientMessage("created", "patient", { ...confirmed, channel: "whatsapp" })).toBeNull();
    expect(patientMessage("cancelled", "patient", confirmed)).toBeNull();
  });
});

describe("who gets told about what", () => {
  it("never messages the doctor about the doctor's own actions", () => {
    expect(staffMessage("cancelled", "staff", base)).toBeNull();
    expect(staffMessage("rescheduled", "calendar", base)).toBeNull();
  });
  it("tells the patient when the clinic cancels or moves the booking", () => {
    expect(patientMessage("cancelled", "calendar", base)).toContain("cancelled by the clinic");
    expect(patientMessage("rescheduled", "calendar", base)).toContain("moved to a new time");
  });
});

import { beforeAll, describe, expect, it } from "vitest";
import { buildIcs, calendarLinks, calendarToken, googleCalendarUrl, verifyCalendarToken, type CalendarEvent } from "../calendar/addToCalendar";
import { patientMessage, staffMessage, type NotifyContext } from "../channels/notify";
import { config } from "../config";

const ID = "7f9c1d2e-0b1a-4c3d-8e4f-5a6b7c8d9e0f";
const event: CalendarEvent = {
  appointmentId: ID, version: 2, startAt: new Date("2031-01-06T03:30:00Z"), endAt: new Date("2031-01-06T04:00:00Z"), status: "CONFIRMED",
  title: "Consultation with Dr. Rao", clinicName: "Demo Clinic, Mumbai", details: "Appointment at Demo Clinic.\nRef: 7f9c1d",
};

beforeAll(() => { config.jwtSecret = "test-secret"; });

describe("signed calendar tokens", () => {
  it("round-trips, and rejects tampering", () => {
    const token = calendarToken(ID);
    expect(verifyCalendarToken(token)).toBe(ID);
    expect(verifyCalendarToken(`${ID.replace("7f9c", "8f9c")}.${token.split(".").pop()}`)).toBeNull(); // someone else's id, same signature
    expect(verifyCalendarToken(`${token}x`)).toBeNull();
    expect(verifyCalendarToken(ID)).toBeNull();
    expect(verifyCalendarToken("")).toBeNull();
  });
  it("depends on the secret", () => {
    const token = calendarToken(ID);
    config.jwtSecret = "another-secret";
    expect(verifyCalendarToken(token)).toBeNull();
    config.jwtSecret = "test-secret";
  });
});

describe("links", () => {
  it("Google URL has the event in UTC", () => {
    const url = new URL(googleCalendarUrl(event));
    expect(url.origin + url.pathname).toBe("https://calendar.google.com/calendar/render");
    expect(url.searchParams.get("dates")).toBe("20310106T033000Z/20310106T040000Z");
    expect(url.searchParams.get("text")).toBe("Consultation with Dr. Rao");
    expect(googleCalendarUrl({ ...event, status: "PENDING_CONFIRMATION" })).toContain("awaiting+confirmation");
  });
  it("no links when the signing secret is missing", () => {
    config.jwtSecret = undefined;
    expect(calendarLinks(event)).toBeUndefined();
    config.jwtSecret = "test-secret";
  });
  it("the ics link carries the signed token and no patient data", () => {
    const { ics } = calendarLinks(event)!;
    expect(ics).toBe(`${config.baseUrl}/v1/public/calendar/${calendarToken(ID)}.ics`);
  });
});

describe("ics file", () => {
  const ics = buildIcs(event);
  it("is a valid calendar with a stable UID, UTC times and escaped text", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics).toContain(`UID:${ID}@booking-bot`);
    expect(ics).toContain("SEQUENCE:2");
    expect(ics).toContain("DTSTART:20310106T033000Z");
    expect(ics).toContain("DTEND:20310106T040000Z");
    expect(ics).toContain("LOCATION:Demo Clinic\\, Mumbai");
    expect(ics).toContain("DESCRIPTION:Appointment at Demo Clinic.\\nRef: 7f9c1d");
    expect(ics).toContain("STATUS:CONFIRMED");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });
  it("is tentative while awaiting the doctor, and folds long lines", () => {
    const pending = buildIcs({ ...event, status: "PENDING_CONFIRMATION", details: "x".repeat(200) });
    expect(pending).toContain("STATUS:TENTATIVE");
    expect(pending).toContain("SUMMARY:Consultation with Dr. Rao (awaiting confirmation)");
    for (const line of pending.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  });
});

describe("messages", () => {
  const links = { google: "https://calendar.google.com/x", ics: "https://api.test/v1/public/calendar/t.ics" };
  const base: NotifyContext = { ref: "7f9c1d", status: "CONFIRMED", channel: "web", patientName: "Asha", patientPhone: "+919876543210", serviceName: "Consultation", resourceName: "Dr. Rao", clinicName: "Demo Clinic", when: "Mon 06 Jan 2031, 9:00 AM", calendar: links };
  const pending = { ...base, status: "PENDING_CONFIRMATION" };
  const has = (m: string | null) => m !== null && m.includes(links.google) && m.includes(links.ics);

  it("confirmed patient messages carry both links", () => {
    for (const [event, actor] of [["created", "patient"], ["paid", "patient"], ["approved", "staff"], ["rescheduled", "staff"], ["reminder", "system"]] as const) {
      expect(has(patientMessage(event, actor, base)), event).toBe(true);
    }
  });
  it("not while still awaiting the doctor, nor on cancel/reject", () => {
    expect(has(patientMessage("created", "patient", pending))).toBe(false);
    expect(has(patientMessage("rescheduled", "staff", pending))).toBe(false);
    expect(has(patientMessage("rejected", "staff", { ...base, status: "REJECTED" }))).toBe(false);
    expect(has(patientMessage("cancelled", "staff", { ...base, status: "CANCELLED" }))).toBe(false);
  });
  it("the doctor's alerts carry them too, never for a cancellation", () => {
    expect(has(staffMessage("created", "patient", pending))).toBe(true);
    expect(staffMessage("created", "patient", pending)).toContain("APPROVE 7f9c1d");
    expect(has(staffMessage("created", "patient", base))).toBe(true);
    expect(has(staffMessage("cancelled", "patient", base))).toBe(false);
  });
  it("messages are unchanged without links", () => {
    expect(patientMessage("approved", "staff", { ...base, calendar: undefined })).not.toContain("calendar");
  });
});

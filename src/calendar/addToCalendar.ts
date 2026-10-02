import { createHmac, timingSafeEqual } from "crypto";
import { config } from "../config";

/**
 * "Add to my calendar" links for patients and doctors. Two forms, so it works on any phone:
 *  - a Google Calendar template URL (opens the Google Calendar app or site with the event filled in), and
 *  - a signed link to an .ics file (iPhone/Apple Calendar, Outlook, and Android open it as "Add to calendar").
 * The .ics link carries only the appointment id and a signature; what it shows (time, status) is read when it is opened,
 * so it always reflects the current booking, and the event's UID is stable so re-adding after a reschedule updates it.
 */

export interface CalendarEvent {
  appointmentId: string;
  version: number;
  startAt: Date;
  endAt: Date;
  status: string;
  title: string; // "Consultation with Dr. Rao"
  clinicName: string;
  details: string;
}

function secret(): string {
  if (!config.jwtSecret) throw new Error("Missing required env var: JWT_SECRET");
  return config.jwtSecret;
}

const sign = (appointmentId: string): string =>
  createHmac("sha256", secret()).update(`calendar-ics:${appointmentId}`).digest("base64url");

/** `<appointment id>.<signature>`: unguessable, so a link can't be forged for someone else's appointment. */
export const calendarToken = (appointmentId: string): string => `${appointmentId}.${sign(appointmentId)}`;

/** The appointment id inside a valid token, or null for anything forged or malformed. */
export function verifyCalendarToken(token: string): string | null {
  const dot = token.lastIndexOf(".");
  if (dot < 1) return null;
  const id = token.slice(0, dot);
  const given = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(id));
  return given.length === expected.length && timingSafeEqual(given, expected) ? id : null;
}

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); // 20261006T090000Z

export function googleCalendarUrl(e: CalendarEvent): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: e.status === "PENDING_CONFIRMATION" ? `${e.title} (awaiting confirmation)` : e.title,
    dates: `${stamp(e.startAt)}/${stamp(e.endAt)}`,
    details: e.details,
    location: e.clinicName,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export const icsUrl = (appointmentId: string): string => `${config.baseUrl}/v1/public/calendar/${calendarToken(appointmentId)}.ics`;

/** Both links, or undefined when links can't be signed (JWT_SECRET unset): a message without links beats no message. */
export function calendarLinks(e: CalendarEvent): { google: string; ics: string } | undefined {
  if (!config.jwtSecret) return undefined;
  return { google: googleCalendarUrl(e), ics: icsUrl(e.appointmentId) };
}

const escapeText = (s: string): string => s.replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** RFC 5545 lines are limited to 75 octets; longer ones continue on the next line after a space. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ` ${rest.slice(cut)}`;
  }
  out.push(rest);
  return out.join("\r\n");
}

export function buildIcs(e: CalendarEvent): string {
  const tentative = e.status === "PENDING_CONFIRMATION";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Clinic Booking Bot//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${e.appointmentId}@booking-bot`, // stable: importing again after a reschedule updates the same event
    `SEQUENCE:${e.version}`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(e.startAt)}`,
    `DTEND:${stamp(e.endAt)}`,
    `SUMMARY:${escapeText(tentative ? `${e.title} (awaiting confirmation)` : e.title)}`,
    `LOCATION:${escapeText(e.clinicName)}`,
    `DESCRIPTION:${escapeText(e.details)}`,
    `STATUS:${tentative ? "TENTATIVE" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

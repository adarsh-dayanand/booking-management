import { DateTime } from "luxon";
import { pool } from "../lib/db";
import { DEFAULT_MIN_NOTICE_MINUTES, generateAvailableSlots, onSlotGrid, openingWindowFor, slotStepMinutes } from "./booking";
import { nearestSpaced } from "./slotPicker";
import type { Slot, TenantConfig } from "../types";

export type UnavailableReason = "past" | "too_soon" | "closed_day" | "outside_hours" | "booked" | "too_close" | "not_on_interval" | "busy";

export type TimeCheck =
  | { available: true; startAt: string }
  | { available: false; reason: UnavailableReason; message: string; nearest: Slot[] };

/** "9:30 AM" — the form patients say and read, in the clinic's own time zone. */
export const clock = (d: Date | string, tz: string): string => DateTime.fromJSDate(new Date(d), { zone: tz }).toFormat("h:mm a");
const clockHHMM = (hhmm: string): string => DateTime.fromFormat(hhmm.slice(0, 5), "HH:mm").toFormat("h:mm a");

/**
 * Is `start` bookable for this service and practitioner — and if not, exactly why. The reason matters: a chat agent
 * that only learns "not available" tells patients that a perfectly free time is booked (or can't explain what to do
 * instead). Mirrors generateAvailableSlots, so "available" here means the same as "offered" there.
 */
export async function diagnoseTime(
  config: TenantConfig,
  resourceId: string,
  serviceId: string,
  start: Date,
  now: Date = new Date(),
  excludeAppointmentId?: string // moving an existing appointment: it must not block its own new time
): Promise<TimeCheck> {
  const tz = config.tenant.timezone;
  const service = config.services.find((s) => s.id === serviceId)!;
  const resource = config.resources.find((r) => r.id === resourceId)!;

  const exact = await generateAvailableSlots(config, resourceId, serviceId, new Date(start.getTime() - 60_000), new Date(start.getTime() + 60_000), { now, excludeAppointmentId });
  if (exact.some((s) => new Date(s.startAt).getTime() === start.getTime())) return { available: true, startAt: start.toISOString() };

  const nearestFree = async (): Promise<Slot[]> => {
    const local = DateTime.fromJSDate(start, { zone: tz });
    const dayStart = Math.max(local.startOf("day").toMillis(), now.getTime());
    const day = await generateAvailableSlots(config, resourceId, serviceId, new Date(dayStart), local.endOf("day").toJSDate(), { now, excludeAppointmentId });
    if (day.length === 0) {
      // nothing left that day: show the next days' first openings instead
      const week = await generateAvailableSlots(config, resourceId, serviceId, new Date(Math.max(local.plus({ days: 1 }).startOf("day").toMillis(), now.getTime())), local.plus({ days: 7 }).endOf("day").toJSDate(), { now, excludeAppointmentId });
      return week.slice(0, 4);
    }
    // spaced by the visit length: alternatives should be genuinely different choices, not neighbouring minutes
    return nearestSpaced(day, tz, local.toFormat("HH:mm"), 4, Math.max(service.durationMinutes, 15));
  };
  const no = async (reason: UnavailableReason, message: string): Promise<TimeCheck> => ({ available: false, reason, message, nearest: await nearestFree() });

  const when = DateTime.fromJSDate(start, { zone: tz }).toFormat("cccc d LLL, h:mm a");
  if (start.getTime() < now.getTime()) return no("past", `${when} has already passed.`);
  if (start.getTime() < now.getTime() + DEFAULT_MIN_NOTICE_MINUTES * 60_000) {
    return no("too_soon", `${when} is too soon — the clinic needs at least ${DEFAULT_MIN_NOTICE_MINUTES} minutes' notice.`);
  }

  const hours = openingWindowFor(config, resourceId, service, start);
  if (!hours.window) return no("closed_day", `${resource.name} isn't working on ${DateTime.fromJSDate(start, { zone: tz }).toFormat("cccc d LLL")}.`);
  if (!hours.within) {
    return no("outside_hours", `${when} is outside ${resource.name}'s hours that day (${clockHHMM(hours.window.start)} to ${clockHHMM(hours.window.end)}); a ${service.durationMinutes}-minute visit must finish by closing time.`);
  }

  // Other bookings. Every visit reserves its length plus its own service's buffer, so a time can be blocked three ways:
  // a true overlap ("booked"), the previous visit's buffer still running, or this visit's buffer running into the next one.
  const end = new Date(start.getTime() + service.durationMinutes * 60_000);
  const footprintEnd = new Date(end.getTime() + service.bufferMinutes * 60_000);
  const clash = await pool.query(
    `SELECT a.start_at, a.end_at, s.buffer_minutes FROM appointments a JOIN services s ON s.id = a.service_id
     WHERE a.tenant_id = $1 AND a.resource_id = $2 AND a.status IN ('AWAITING_PAYMENT', 'PENDING_CONFIRMATION', 'CONFIRMED')
       AND a.start_at < $4 AND a.end_at + make_interval(mins => s.buffer_minutes) > $3
       AND ($5::uuid IS NULL OR a.id <> $5)
     ORDER BY a.start_at`,
    [config.tenant.id, resourceId, start, footprintEnd, excludeAppointmentId ?? null]
  );
  const visits = clash.rows.map((r) => ({ start: new Date(r.start_at), end: new Date(r.end_at), buffer: r.buffer_minutes as number }));
  if (visits.some((v) => v.start < end && v.end > start)) {
    return no("booked", `${resource.name} already has an appointment at ${when} (or one overlapping it).`);
  }
  const previous = visits.find((v) => v.end <= start); // finished, but its buffer is still running
  if (previous) {
    const free = new Date(previous.end.getTime() + previous.buffer * 60_000);
    return no("too_close", `${when} is right after another appointment (it ends ${clock(previous.end, tz)}), and the clinic keeps a ${previous.buffer}-minute gap between visits, so the earliest start there is ${clock(free, tz)}.`);
  }
  if (visits.length > 0) {
    return no("too_close", `${when} is right before another appointment, and the clinic keeps a ${service.bufferMinutes}-minute gap between visits.`);
  }

  // Free and in hours, but not one of the times the clinic offers.
  if (!onSlotGrid(config, resourceId, service, start)) {
    return no("not_on_interval", `${resource.name} books ${service.name} every ${slotStepMinutes(service)} minutes starting at ${clockHHMM(hours.window.start)}, so ${clock(start, tz)} isn't one of the start times.`);
  }
  return no("busy", `${resource.name}'s calendar shows ${when} as busy.`);
}

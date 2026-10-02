import { DateTime } from "luxon";
import { z } from "zod";
import { diagnoseTime, clock, type TimeCheck } from "../booking/availability";
import { label, type Tool, type ToolContext } from "./toolKit";

/** How a model may name a moment: a clinic-local date + time (preferred), or an ISO timestamp it copied from a tool. */
export const whenFields = {
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD").optional(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use 24-hour HH:MM, e.g. 13:30").optional(),
  startAt: z.string().optional(),
};

export const whenParameters = {
  date: { type: "string", description: "Day in the CLINIC's local calendar, YYYY-MM-DD. Use with `time`." },
  time: { type: "string", description: "Clinic-local time, 24-hour HH:MM (1:30 PM → 13:30). Never convert to UTC or another time zone." },
  startAt: { type: "string", description: "Alternative to date+time: an ISO timestamp copied exactly from a tool result. Without an offset it is read as clinic time." },
};

/**
 * Resolve the moment a model named into an instant. Times are interpreted in the CLINIC's time zone — models are good
 * at "13:30 on 2026-10-05" and bad at writing the right UTC offset, and a wrong offset silently turns a free 1:30 PM
 * into an "unavailable" 7:00 PM.
 */
export function resolveWhen(ctx: ToolContext, args: { date?: string; time?: string; startAt?: string }): { start: Date } | { error: string } {
  const tz = ctx.config.tenant.timezone;
  let dt: DateTime;
  if (args.date || args.time) {
    if (!args.date || !args.time) return { error: "Give both `date` (YYYY-MM-DD) and `time` (HH:MM, 24-hour, clinic time)." };
    dt = DateTime.fromISO(`${args.date}T${args.time}`, { zone: tz });
  } else if (args.startAt) {
    // An explicit offset (or Z) means the model copied a real instant; a bare date-time means clinic-local.
    dt = /(Z|[+-]\d{2}:?\d{2})$/.test(args.startAt) ? DateTime.fromISO(args.startAt, { setZone: false }) : DateTime.fromISO(args.startAt, { zone: tz });
  } else {
    return { error: "Say when: pass `date` and `time` (clinic time, 24-hour), or `startAt`." };
  }
  if (!dt.isValid) return { error: "That date/time isn't valid. Use date YYYY-MM-DD and time HH:MM (24-hour)." };
  return { start: dt.toJSDate() };
}

/**
 * Which service and practitioner a call means. A clinic with one of each needs no ids at all; otherwise accept an id or
 * the exact name, and say plainly what to do when it can't be worked out (instead of a bare "Invalid uuid").
 */
export function resolveIds(ctx: ToolContext, args: { serviceId?: string; practitionerId?: string }): { serviceId: string; practitionerId: string } | { error: string } {
  const pick = <T extends { id: string; name: string }>(items: T[], given: string | undefined, what: string, listTool: string): T | string => {
    if (given) {
      const wanted = given.trim().toLowerCase();
      return items.find((i) => i.id === given || i.name.toLowerCase() === wanted) ?? `Unknown ${what} "${given}". Use an id from ${listTool}.`;
    }
    if (items.length === 1) return items[0];
    return items.length === 0 ? `This clinic has no ${what} set up.` : `Which ${what}? Call ${listTool} and use one of its ids.`;
  };
  const service = pick(ctx.config.services.filter((s) => s.active), args.serviceId, "service", "list_services");
  if (typeof service === "string") return { error: service };
  const practitioner = pick(ctx.config.resources.filter((r) => r.active), args.practitionerId, "practitioner", "list_practitioners");
  if (typeof practitioner === "string") return { error: practitioner };
  return { serviceId: service.id, practitionerId: practitioner.id };
}

/** The reply when a time can't be booked: the real reason plus the nearest free times, ready for the model to relay. */
export function unavailableReply(ctx: ToolContext, check: Extract<TimeCheck, { available: false }>) {
  const tz = ctx.config.tenant.timezone;
  return {
    available: false,
    reason: check.reason,
    error: check.message,
    nearestFreeTimes: check.nearest.map((s) => ({ date: DateTime.fromISO(s.startAt, { zone: "utc" }).setZone(tz).toISODate(), time: DateTime.fromISO(s.startAt, { zone: "utc" }).setZone(tz).toFormat("HH:mm"), local: label(s.startAt, tz), startAt: s.startAt })),
    note: "Tell the patient the reason in plain words and offer these nearest free times. Do not call the time booked unless the reason is 'booked'.",
  };
}

/** Collapse a day's free start times into ranges ("9:00 AM to 4:30 PM"), so the agent sees ALL of them, not a sample. */
export function freeRanges(
  slots: { startAt: string; practitionerId: string; practitionerName: string }[],
  tz: string,
  intervalMinutes: number
): { practitioner: string; date: string; day: string; from: string; to: string }[] {
  const out: { practitioner: string; date: string; day: string; from: string; to: string; at: number }[] = [];
  const byPractitioner = new Map<string, typeof slots>();
  for (const s of slots) (byPractitioner.get(s.practitionerId) ?? byPractitioner.set(s.practitionerId, []).get(s.practitionerId)!).push(s);
  for (const list of byPractitioner.values()) {
    list.sort((a, b) => a.startAt.localeCompare(b.startAt));
    let runStart = list[0];
    let prev = list[0];
    const flush = () => {
      const a = DateTime.fromISO(runStart.startAt, { zone: "utc" }).setZone(tz);
      const b = DateTime.fromISO(prev.startAt, { zone: "utc" }).setZone(tz);
      out.push({ practitioner: runStart.practitionerName, date: a.toISODate()!, day: a.toFormat("ccc d LLL"), from: a.toFormat("h:mm a"), to: b.toFormat("h:mm a"), at: Date.parse(runStart.startAt) });
    };
    for (const s of list.slice(1)) {
      const gap = (Date.parse(s.startAt) - Date.parse(prev.startAt)) / 60_000;
      if (gap !== intervalMinutes) { flush(); runStart = s; }
      prev = s;
    }
    flush();
  }
  // chronological by the real instant — sorting the 12-hour text would put "10:00 AM" before "9:00 AM"
  return out.sort((a, b) => a.at - b.at).map(({ at: _at, ...range }) => range);
}

export const whenTools: Tool[] = [
  {
    write: false,
    declaration: {
      name: "check_time",
      description:
        "Check ONE specific time the patient asked for (e.g. 'is 1:30 PM Monday free?'). Always use this instead of guessing from the sample returned by get_available_slots — that list is only a sample. Returns available true/false; when false, the exact reason and the nearest free times.",
      parameters: {
        type: "object",
        properties: {
          serviceId: { type: "string", description: "From list_services. Optional when the clinic has only one service." },
          practitionerId: { type: "string", description: "From list_practitioners. Optional when there is only one." },
          date: whenParameters.date,
          time: whenParameters.time,
        },
        required: ["date", "time"],
      },
    },
    run: async (raw, ctx) => {
      const args = z.object({ serviceId: z.string().optional(), practitionerId: z.string().optional(), ...whenFields }).parse(raw);
      const when = resolveWhen(ctx, args);
      if ("error" in when) return when;
      const ids = resolveIds(ctx, args);
      if ("error" in ids) return ids;
      const check = await diagnoseTime(ctx.config, ids.practitionerId, ids.serviceId, when.start);
      if (!check.available) return unavailableReply(ctx, check);
      const tz = ctx.config.tenant.timezone;
      return { available: true, startAt: check.startAt, local: label(check.startAt, tz), spoken: `${DateTime.fromJSDate(when.start, { zone: tz }).toFormat("cccc d LLLL")} at ${clock(when.start, tz)}` };
    },
  },
];

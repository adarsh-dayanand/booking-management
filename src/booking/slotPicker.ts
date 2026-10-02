import { DateTime } from "luxon";

/**
 * With a fine slot interval (say 5 minutes) a day has dozens of bookable start times, so "the first N" would all be
 * clustered at opening time. These helpers choose a useful handful instead.
 */

/** `max` items spread evenly across the list, always including the first and last. */
export function spreadEvenly<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  if (max <= 1) return items.slice(0, 1);
  const picked = new Set<number>();
  for (let i = 0; i < max; i++) picked.add(Math.round((i * (items.length - 1)) / (max - 1)));
  return [...picked].sort((a, b) => a - b).map((i) => items[i]);
}

const minuteOfDay = (iso: string, tz: string): number => {
  const d = DateTime.fromISO(iso, { zone: "utc" }).setZone(tz);
  return d.hour * 60 + d.minute;
};

/** The slots on one day closest to a wanted time of day ("17:00"), returned in time order. */
export function nearestTo<T extends { startAt: string }>(daySlots: T[], tz: string, hhmm: string, count: number): T[] {
  const [h, m] = hhmm.split(":").map(Number);
  const target = h * 60 + m;
  return [...daySlots]
    .sort((a, b) => Math.abs(minuteOfDay(a.startAt, tz) - target) - Math.abs(minuteOfDay(b.startAt, tz) - target))
    .slice(0, count)
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
}

/** Group slots (already sorted by time) by local calendar day. */
export function groupByDay<T extends { startAt: string }>(slots: T[], tz: string): T[][] {
  const days = new Map<string, T[]>();
  for (const s of slots) {
    const day = DateTime.fromISO(s.startAt, { zone: "utc" }).setZone(tz).toISODate()!;
    (days.get(day) ?? days.set(day, []).get(day)!).push(s);
  }
  return [...days.values()];
}

/** A short menu for the numbered chat flow: a few well-spaced times per day, over the next days, `total` at most. */
export function menuSlots<T extends { startAt: string }>(slots: T[], tz: string, total = 8, perDay = 3): T[] {
  const out: T[] = [];
  for (const day of groupByDay(slots, tz)) {
    if (out.length >= total) break;
    out.push(...spreadEvenly(day, Math.min(perDay, total - out.length)));
  }
  return out;
}

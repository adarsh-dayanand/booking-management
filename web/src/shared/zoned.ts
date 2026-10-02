// Wall-clock <-> instant conversion for an IANA time zone, using only Intl (no date library in the browser bundle).
// A clinic's hours and bookings live in the clinic's zone, which is not necessarily the browser's.

export interface Wall { y: number; m: number; d: number; h: number; min: number } // m is 1-12

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    formatters.set(tz, f);
  }
  return f;
}

/** What the wall clock in `tz` reads at this instant. */
export function wallInZone(date: Date, tz: string): Wall {
  const parts = Object.fromEntries(formatter(tz).formatToParts(date).map((p) => [p.type, p.value]));
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour % 24, min: +parts.minute };
}

const asUtc = (w: Wall) => Date.UTC(w.y, w.m - 1, w.d, w.h, w.min);

/** The instant at which the wall clock in `tz` reads `w` (re-checks the offset so DST changes are handled). */
export function zonedToUtc(w: Wall, tz: string): Date {
  const guess = asUtc(w);
  const offset = (t: number) => asUtc(wallInZone(new Date(t), tz)) - t;
  let utc = guess - offset(guess);
  const second = offset(utc);
  if (second !== guess - utc) utc = guess - second;
  return new Date(utc);
}

/** "YYYY-MM-DDTHH:mm" — the string form the picker edits. */
export const toLocalString = (w: Wall): string => `${pad(w.y, 4)}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.min)}`;

export function parseLocal(s: string): Wall {
  const [date, time = "00:00"] = s.split("T");
  const [y, m, d] = date.split("-").map(Number);
  const [h, min] = time.split(":").map(Number);
  return { y, m, d, h, min };
}

export const localStringIn = (date: Date, tz: string): string => toLocalString(wallInZone(date, tz));

export function formatInZone(iso: string | Date, tz: string, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }): string {
  return new Date(iso).toLocaleString(undefined, { timeZone: tz, ...opts });
}

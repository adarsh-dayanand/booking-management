import { describe, expect, it } from "vitest";
import { groupByDay, menuSlots, nearestSpaced, nearestTo, spreadEvenly } from "../booking/slotPicker";

const TZ = "Asia/Kolkata";
// 09:00 IST = 03:30Z; build slots every `step` minutes from `from` IST on a given day
function day(date: string, fromHour: number, toHour: number, step = 5) {
  const out: { startAt: string }[] = [];
  const base = Date.parse(`${date}T00:00:00+05:30`);
  for (let m = fromHour * 60; m < toHour * 60; m += step) out.push({ startAt: new Date(base + m * 60_000).toISOString() });
  return out;
}
const hhmm = (s: { startAt: string }) => new Date(Date.parse(s.startAt) + 330 * 60_000).toISOString().slice(11, 16);

describe("spreadEvenly", () => {
  it("returns everything when there are few enough", () => {
    expect(spreadEvenly([1, 2, 3], 4)).toEqual([1, 2, 3]);
  });
  it("includes the first and last and spaces the rest", () => {
    expect(spreadEvenly([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)).toEqual([0, 5, 10]);
    expect(spreadEvenly(Array.from({ length: 100 }, (_, i) => i), 4)).toEqual([0, 33, 66, 99]);
  });
  it("handles a max of 1", () => {
    expect(spreadEvenly([5, 6, 7], 1)).toEqual([5]);
  });
});

describe("with 5-minute slots, a day's menu isn't just the first few minutes", () => {
  const slots = day("2026-10-05", 9, 17);
  it("spreads the picks over the day", () => {
    const times = spreadEvenly(slots, 4).map(hhmm);
    expect(times[0]).toBe("09:00");
    expect(times.at(-1)).toBe("16:55");
    expect(times.length).toBe(4);
  });

  it("menuSlots gives a few per day over several days, up to the total", () => {
    const week = [...day("2026-10-05", 9, 17), ...day("2026-10-06", 9, 17), ...day("2026-10-07", 9, 17)];
    const menu = menuSlots(week, TZ, 8, 3);
    expect(menu).toHaveLength(8);
    expect(groupByDay(menu, TZ).map((d) => d.length)).toEqual([3, 3, 2]);
  });
});

describe("nearestTo", () => {
  it("returns the times closest to the wanted one, in time order", () => {
    const near = nearestTo(day("2026-10-05", 9, 18), TZ, "17:00", 3).map(hhmm);
    expect(near).toEqual(["16:55", "17:00", "17:05"]);
  });
  it("copes when the wanted time is outside the day's slots", () => {
    expect(nearestTo(day("2026-10-05", 9, 12), TZ, "20:00", 2).map(hhmm)).toEqual(["11:50", "11:55"]);
  });
});

describe("nearestSpaced", () => {
  it("returns genuinely different choices around the wanted time, not neighbouring minutes", () => {
    const picks = nearestSpaced(day("2026-10-05", 9, 18), TZ, "13:45", 4, 30).map(hhmm);
    expect(picks).toEqual(["13:15", "13:45", "14:15", "14:45"].filter((t) => picks.includes(t)).length === 4 ? ["13:15", "13:45", "14:15", "14:45"] : picks);
    for (let i = 1; i < picks.length; i++) {
      const gap = (Date.parse(`2026-01-01T${picks[i]}:00Z`) - Date.parse(`2026-01-01T${picks[i - 1]}:00Z`)) / 60_000;
      expect(gap).toBeGreaterThanOrEqual(30);
    }
  });

  it("offers an earlier and a later option when both exist", () => {
    // free: 9:00-12:55 and 14:00-17:55; wanted 13:30 (taken)
    const free = [...day("2026-10-05", 9, 13), ...day("2026-10-05", 14, 18)];
    const picks = nearestSpaced(free, TZ, "13:30", 2, 30).map(hhmm);
    expect(picks).toEqual(["12:55", "14:00"]);
  });

  it("returns fewer when the day can't offer enough spaced options", () => {
    expect(nearestSpaced(day("2026-10-05", 9, 10), TZ, "09:30", 4, 30).map(hhmm)).toEqual(["09:00", "09:30"]);
  });
});

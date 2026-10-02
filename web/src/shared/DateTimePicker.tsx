import { useMemo, useState } from "react";
import { cx } from "./ui";
import { parseLocal, toLocalString, type Wall } from "./zoned";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");
const dateKey = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Weeks (Monday first) covering a month, with the neighbouring months' days filling the edges. */
function monthGrid(y: number, m: number): { y: number; m: number; d: number; outside: boolean }[] {
  const first = new Date(Date.UTC(y, m - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7; // Monday = 0
  const cells = [];
  for (let i = -lead; i < 42 - lead; i++) {
    const day = new Date(Date.UTC(y, m - 1, 1 + i));
    cells.push({ y: day.getUTCFullYear(), m: day.getUTCMonth() + 1, d: day.getUTCDate(), outside: day.getUTCMonth() !== m - 1 });
  }
  // drop a trailing all-outside week
  return cells.slice(0, cells.slice(35).every((c) => c.outside) ? 35 : 42);
}

/** Minutes offered in the minute menu: multiples of the step within the hour (always including the current value). */
function minuteOptions(step: number, current: number): number[] {
  const every = step >= 60 ? 60 : step;
  const list = Array.from({ length: Math.ceil(60 / every) }, (_, i) => i * every).filter((m) => m < 60);
  return list.includes(current) ? list : [...list, current].sort((a, b) => a - b);
}

export interface DateTimePickerProps {
  /** Wall-clock "YYYY-MM-DDTHH:mm" in whatever zone the caller works in. */
  value: string;
  onChange: (value: string) => void;
  /** Earliest selectable day, "YYYY-MM-DD". */
  minDate?: string;
  /** Minutes between choosable times (the consultant's slot interval). */
  stepMinutes: number;
}

/**
 * A month calendar plus an hour / minute / AM-PM selector. Deliberately not the browser's native datetime-local, whose
 * look and keyboard behaviour differ wildly between browsers. Picks any time on the step grid — it does not restrict to
 * working hours, so a consultant can schedule whenever they want.
 */
export function DateTimePicker({ value, onChange, minDate, stepMinutes }: DateTimePickerProps) {
  const w = parseLocal(value);
  const [view, setView] = useState({ y: w.y, m: w.m });
  const grid = useMemo(() => monthGrid(view.y, view.m), [view]);
  const selectedKey = dateKey(w.y, w.m, w.d);
  const hour12 = w.h % 12 === 0 ? 12 : w.h % 12;
  const pm = w.h >= 12;
  const minutes = minuteOptions(stepMinutes, w.min);
  const today = (() => { const n = new Date(); return dateKey(n.getFullYear(), n.getMonth() + 1, n.getDate()); })();

  const set = (patch: Partial<Wall>) => onChange(toLocalString({ ...w, ...patch }));
  const setHour12 = (h: number, isPm: boolean) => set({ h: (h % 12) + (isPm ? 12 : 0) });
  const shiftMonth = (delta: number) => setView(({ y, m }) => { const t = new Date(Date.UTC(y, m - 1 + delta, 1)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1 }; });
  const prevDisabled = minDate ? dateKey(view.y, view.m, 1) <= minDate : false;

  const summary = new Date(Date.UTC(w.y, w.m - 1, w.d)).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });

  return (
    <div className="dtp">
      <div className="dtp-cal" role="group" aria-label="Pick a date">
        <div className="dtp-head">
          <button type="button" className="dtp-nav" aria-label="Previous month" onClick={() => shiftMonth(-1)} disabled={prevDisabled}>‹</button>
          <div className="dtp-month" aria-live="polite">{MONTHS[view.m - 1]} {view.y}</div>
          <button type="button" className="dtp-nav" aria-label="Next month" onClick={() => shiftMonth(1)}>›</button>
        </div>
        <div className="dtp-grid">
          {DOW.map((d) => <div key={d} className="dtp-dow" aria-hidden="true">{d}</div>)}
          {grid.map((c) => {
            const key = dateKey(c.y, c.m, c.d);
            const label = new Date(Date.UTC(c.y, c.m - 1, c.d)).toLocaleDateString(undefined, { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" });
            return (
              <button
                key={key}
                type="button"
                data-date={key}
                aria-label={label}
                aria-pressed={key === selectedKey}
                disabled={Boolean(minDate && key < minDate)}
                className={cx("dtp-day", c.outside && "outside", key === today && "today")}
                onClick={() => { set({ y: c.y, m: c.m, d: c.d }); if (c.outside) setView({ y: c.y, m: c.m }); }}
              >
                {c.d}
              </button>
            );
          })}
        </div>
      </div>
      <div className="dtp-time" role="group" aria-label="Pick a time">
        <div className="eyebrow">Time</div>
        <div className="dtp-selects">
          <select aria-label="Hour" value={hour12} onChange={(e) => setHour12(Number(e.target.value), pm)}>
            {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => <option key={h} value={h}>{pad(h)}</option>)}
          </select>
          <select aria-label="Minute" value={w.min} onChange={(e) => set({ min: Number(e.target.value) })}>
            {minutes.map((m) => <option key={m} value={m}>{pad(m)}</option>)}
          </select>
        </div>
        <div className="dtp-ampm" role="group" aria-label="AM or PM">
          <button type="button" aria-pressed={!pm} onClick={() => setHour12(hour12, false)}>AM</button>
          <button type="button" aria-pressed={pm} onClick={() => setHour12(hour12, true)}>PM</button>
        </div>
        <div className="dtp-summary">
          <strong>{pad(hour12)}:{pad(w.min)} {pm ? "PM" : "AM"}</strong>
          {summary}
        </div>
      </div>
    </div>
  );
}

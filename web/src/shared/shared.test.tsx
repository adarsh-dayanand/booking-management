import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateTimePicker } from "./DateTimePicker";
import { localStringIn, parseLocal, toLocalString, wallInZone, zonedToUtc } from "./zoned";

afterEach(cleanup);

describe("zone conversion", () => {
  it("reads the wall clock in a zone and converts back to the instant", () => {
    const instant = new Date("2031-01-01T10:00:00Z");
    expect(wallInZone(instant, "Asia/Kolkata")).toEqual({ y: 2031, m: 1, d: 1, h: 15, min: 30 });
    expect(wallInZone(instant, "America/New_York")).toEqual({ y: 2031, m: 1, d: 1, h: 5, min: 0 });
    expect(zonedToUtc({ y: 2031, m: 1, d: 1, h: 15, min: 30 }, "Asia/Kolkata").toISOString()).toBe("2031-01-01T10:00:00.000Z");
  });

  it("uses the right offset either side of a daylight-saving change", () => {
    expect(zonedToUtc({ y: 2031, m: 1, d: 15, h: 9, min: 0 }, "America/New_York").toISOString()).toBe("2031-01-15T14:00:00.000Z"); // EST, UTC-5
    expect(zonedToUtc({ y: 2031, m: 7, d: 15, h: 9, min: 0 }, "America/New_York").toISOString()).toBe("2031-07-15T13:00:00.000Z"); // EDT, UTC-4
  });

  it("round-trips every 5 minutes across a day, including a DST day", () => {
    for (const day of [{ y: 2031, m: 3, d: 9 }, { y: 2031, m: 11, d: 2 }, { y: 2031, m: 6, d: 1 }]) {
      for (let min = 0; min < 24 * 60; min += 5) {
        if (day.m === 3 && min >= 120 && min < 180) continue; // 02:00-03:00 doesn't exist on the spring-forward day
        const wall = { ...day, h: Math.floor(min / 60), min: min % 60 };
        const back = wallInZone(zonedToUtc(wall, "America/New_York"), "America/New_York");
        // the autumn repeated hour (01:00-02:00) may resolve to either instant, but the wall time must match
        expect(back).toEqual(wall);
      }
    }
  });

  it("copes with the spring-forward gap without throwing", () => {
    const d = zonedToUtc({ y: 2031, m: 3, d: 9, h: 2, min: 30 }, "America/New_York");
    expect(Number.isNaN(d.getTime())).toBe(false);
  });

  it("formats and parses the picker's string form", () => {
    expect(toLocalString({ y: 2031, m: 1, d: 5, h: 9, min: 5 })).toBe("2031-01-05T09:05");
    expect(parseLocal("2031-01-05T09:05")).toEqual({ y: 2031, m: 1, d: 5, h: 9, min: 5 });
    expect(localStringIn(new Date("2031-01-01T10:00:00Z"), "Asia/Kolkata")).toBe("2031-01-01T15:30");
  });
});

function Harness({ initial, minDate, step = 5, onChange }: { initial: string; minDate?: string; step?: number; onChange?: (v: string) => void }) {
  const [value, setValue] = useState(initial);
  return <DateTimePicker value={value} minDate={minDate} stepMinutes={step} onChange={(v) => { setValue(v); onChange?.(v); }} />;
}
const day = (iso: string) => document.querySelector<HTMLButtonElement>(`[data-date="${iso}"]`)!;
const hour = () => screen.getByRole("combobox", { name: "Hour" }) as HTMLSelectElement;
const minute = () => screen.getByRole("combobox", { name: "Minute" }) as HTMLSelectElement;
const minuteOptions = () => Array.from(minute().querySelectorAll("option")).map((o) => o.textContent);

describe("DateTimePicker", () => {
  it("shows the month of the value and marks the selected day", () => {
    render(<Harness initial="2031-01-15T15:30" />);
    expect(screen.getByText("January 2031")).toBeInTheDocument();
    expect(day("2031-01-15")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("03:30 PM")).toBeInTheDocument();
  });

  it("picking a day keeps the time", async () => {
    const onChange = vi.fn();
    render(<Harness initial="2031-01-15T15:30" onChange={onChange} />);
    await userEvent.click(day("2031-01-20"));
    expect(onChange).toHaveBeenLastCalledWith("2031-01-20T15:30");
  });

  it("moves between months, and clicking a neighbouring month's day jumps there", async () => {
    const onChange = vi.fn();
    render(<Harness initial="2031-01-15T09:00" onChange={onChange} />);
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    expect(screen.getByText("February 2031")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    await userEvent.click(screen.getByRole("button", { name: "Previous month" }));
    expect(screen.getByText("December 2030")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Next month" }));
    // 2031-02-01 is a Saturday, so the January view's last row shows 1 Feb as a neighbouring day
    await userEvent.click(day("2031-02-01"));
    expect(onChange).toHaveBeenLastCalledWith("2031-02-01T09:00");
    expect(screen.getByText("February 2031")).toBeInTheDocument();
  });

  it("disables days before minDate and the previous-month arrow at the limit", () => {
    render(<Harness initial="2031-01-15T09:00" minDate="2031-01-10" />);
    expect(day("2031-01-09")).toBeDisabled();
    expect(day("2031-01-10")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Previous month" })).toBeDisabled();
  });

  it("converts between the 12-hour controls and 24-hour values", async () => {
    const onChange = vi.fn();
    render(<Harness initial="2031-01-15T15:30" onChange={onChange} />);
    expect(hour()).toHaveValue("3");
    await userEvent.click(screen.getByRole("button", { name: "AM" }));
    expect(onChange).toHaveBeenLastCalledWith("2031-01-15T03:30");
    await userEvent.selectOptions(hour(), "12"); // 12 AM = midnight
    expect(onChange).toHaveBeenLastCalledWith("2031-01-15T00:30");
    await userEvent.click(screen.getByRole("button", { name: "PM" })); // 12 PM = noon
    expect(onChange).toHaveBeenLastCalledWith("2031-01-15T12:30");
    await userEvent.selectOptions(hour(), "11");
    expect(onChange).toHaveBeenLastCalledWith("2031-01-15T23:30");
  });

  it("offers minutes at the given step", () => {
    const { unmount } = render(<Harness initial="2031-01-15T09:00" step={5} />);
    expect(minuteOptions()).toEqual(["00", "05", "10", "15", "20", "25", "30", "35", "40", "45", "50", "55"]);
    unmount();
    const second = render(<Harness initial="2031-01-15T09:00" step={15} />);
    expect(minuteOptions()).toEqual(["00", "15", "30", "45"]);
    second.unmount();
    const third = render(<Harness initial="2031-01-15T09:00" step={45} />);
    expect(minuteOptions()).toEqual(["00", "45"]);
    third.unmount();
    render(<Harness initial="2031-01-15T09:00" step={90} />);
    expect(minuteOptions()).toEqual(["00"]);
  });

  it("keeps a current minute that isn't on the step grid, so the value is never silently changed", () => {
    render(<Harness initial="2031-01-15T09:07" step={15} />);
    expect(minuteOptions()).toEqual(["00", "07", "15", "30", "45"]);
    expect(minute()).toHaveValue("7");
  });

  it("lets any minute on the grid be chosen", async () => {
    const onChange = vi.fn();
    render(<Harness initial="2031-01-15T09:00" onChange={onChange} />);
    await userEvent.selectOptions(minute(), "35");
    expect(onChange).toHaveBeenLastCalledWith("2031-01-15T09:35");
  });

  it("labels the date and time groups for assistive tech", () => {
    render(<Harness initial="2031-01-15T09:00" />);
    expect(screen.getByRole("group", { name: "Pick a date" })).toBeInTheDocument();
    const time = screen.getByRole("group", { name: "Pick a time" });
    expect(within(time).getByRole("group", { name: "AM or PM" })).toBeInTheDocument();
  });
});

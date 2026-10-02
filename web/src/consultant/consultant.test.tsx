import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { tokens } from "./api";
import { toCsv, formatRupees } from "../shared/format";
import { mockApi } from "../test-utils";
import { toPricing } from "./pages/Payments";
import type { Appointment, Overview } from "./types";

beforeEach(() => {
  localStorage.clear();
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SETTINGS = { name: "Demo Clinic", timezone: "Asia/Kolkata", confirmationPolicy: "staff_approval", staffWhatsappNumber: null, reminderHoursBefore: 24, faqText: null, whatsappPhoneNumberId: null };
const OVERVIEW: Overview = {
  timezone: "Asia/Kolkata", paymentsActive: true, today: 3, next7Days: 12, pendingApproval: 2, awaitingPayment: 1, syncFailed: 0, users: 40, newUsers30d: 6,
  revenue: { todayPaise: 150000, last30DaysPaise: 2500000, paidCount30d: 17 },
  upcoming: [{ id: "u1", status: "CONFIRMED", start_at: "2031-01-01T10:00:00Z", patient_name: "Asha Rao", service_name: "Consult", resource_name: "Dr Rao" }],
};
const appt = (over: Partial<Appointment> = {}): Appointment => ({
  id: "a1", service_id: "s1", resource_id: "r1", start_at: "2031-01-01T10:00:00Z", patient_name: "Asha", patient_phone: "+919000000001", service_name: "Consult",
  resource_name: "Dr Rao", channel: "web", status: "CONFIRMED", payment_status: null, amount_paise: null, calendar_sync_status: "synced", ...over,
});
const SERVICE = { id: "s1", name: "Consult", durationMinutes: 30, bufferMinutes: 5, active: true };
const RESOURCE = { id: "r1", name: "Dr Rao", active: true, googleConnectionStatus: "disconnected", googleCalendarId: null };

/** Boot the app already logged in, on the given page, with the base routes every page needs. */
function open(page: string, routes: Record<string, unknown> = {}) {
  tokens.set("jwt");
  window.location.hash = `#/${page}`;
  const api = mockApi({ "GET /v1/consultant/settings": { settings: SETTINGS }, ...routes } as never);
  render(<App />);
  return api;
}

describe("login and session", () => {
  it("logs in, stores the token and lands on the overview", async () => {
    const api = mockApi({
      "POST /v1/consultant/login": { token: "jwt-1" },
      "GET /v1/consultant/settings": { settings: SETTINGS },
      "GET /v1/consultant/overview": OVERVIEW,
      "GET /v1/consultant/services": { services: [SERVICE] },
      "GET /v1/consultant/resources": { resources: [] },
    });
    render(<App />);
    await userEvent.type(screen.getByLabelText("Email"), "owner@demo-clinic.test");
    await userEvent.type(screen.getByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("heading", { name: "Overview" })).toBeInTheDocument();
    expect(tokens.get()).toBe("jwt-1");
    expect(api.calls[0]).toMatchObject({ path: "/v1/consultant/login", body: { email: "owner@demo-clinic.test", password: "pw" }, auth: undefined });
  });

  it("shows the server's error for bad credentials", async () => {
    mockApi({ "POST /v1/consultant/login": { status: 401, body: { error: "Invalid email or password" } } });
    render(<App />);
    await userEvent.type(screen.getByLabelText("Email"), "a@b.co");
    await userEvent.type(screen.getByLabelText("Password"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
    expect(tokens.get()).toBeNull();
  });

  it("falls back to the login screen when the session has expired", async () => {
    tokens.set("expired");
    mockApi({ "GET /v1/consultant/settings": { status: 401, body: { error: "expired" } } });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Consultant login" })).toBeInTheDocument();
    expect(tokens.get()).toBeNull();
  });

  it("sends the stored token as a bearer token, and logs out", async () => {
    tokens.set("old-session");
    const api = mockApi({ "GET /v1/consultant/settings": { settings: SETTINGS }, "GET /v1/consultant/overview": OVERVIEW, "GET /v1/consultant/services": { services: [SERVICE] }, "GET /v1/consultant/resources": { resources: [] } });
    render(<App />);
    await screen.findByText("Next appointments");
    expect(api.calls.every((c) => c.auth === "Bearer old-session")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Log out" }));
    expect(screen.getByRole("heading", { name: "Consultant login" })).toBeInTheDocument();
    expect(tokens.get()).toBeNull();
  });
});

describe("overview", () => {
  it("shows today's numbers, revenue and upcoming bookings", async () => {
    open("overview", { "GET /v1/consultant/overview": OVERVIEW, "GET /v1/consultant/services": { services: [SERVICE] }, "GET /v1/consultant/resources": { resources: [] } });
    expect(await screen.findByText("Asha Rao", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("Needs your approval").closest("button")).toHaveTextContent("2");
    expect(screen.getByText(formatRupees(2500000))).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();
  });

  it("hides payment numbers when the consultant isn't collecting payments", async () => {
    open("overview", { "GET /v1/consultant/overview": { ...OVERVIEW, paymentsActive: false }, "GET /v1/consultant/services": { services: [SERVICE] }, "GET /v1/consultant/resources": { resources: [] } });
    await screen.findByText("Next appointments");
    expect(screen.queryByText("Revenue, 30 days")).toBeNull();
    expect(screen.queryByText("Awaiting payment")).toBeNull();
  });

  it("guides a brand-new consultant through setup", async () => {
    open("overview", { "GET /v1/consultant/overview": OVERVIEW, "GET /v1/consultant/services": { services: [] }, "GET /v1/consultant/resources": { resources: [] } });
    expect(await screen.findByText("Finish setting up")).toBeInTheDocument();
    expect(screen.getByText("Add a service")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Set up" })[0]);
    expect(window.location.hash).toBe("#/services");
  });

  it("warns when calendar syncs failed", async () => {
    open("overview", { "GET /v1/consultant/overview": { ...OVERVIEW, syncFailed: 2 }, "GET /v1/consultant/services": { services: [SERVICE] }, "GET /v1/consultant/resources": { resources: [] } });
    expect(await screen.findByText(/2 appointments failed to sync/)).toBeInTheDocument();
  });
});

describe("appointments", () => {
  const list = [
    appt({ id: "p", patient_name: "Pending Pat", status: "PENDING_CONFIRMATION" }),
    appt({ id: "w", patient_name: "Waiting Wes", status: "AWAITING_PAYMENT", payment_status: "created", amount_paise: 50000 }),
    appt({ id: "c", patient_name: "Cancelled Cy", status: "CANCELLED" }),
    appt({ id: "f", patient_name: "Failed Fay", status: "CONFIRMED", calendar_sync_status: "failed" }),
  ];
  const rowOf = (name: string) => screen.getByText(name).closest("tr")!;
  const buttonsIn = (row: HTMLElement) => within(row).queryAllByRole("button").map((b) => b.textContent);

  it("offers the right actions per status — an unpaid hold can't be approved or rescheduled", async () => {
    open("appointments/all", { "GET /v1/consultant/appointments": { appointments: list } });
    await screen.findByText("Pending Pat");
    expect(buttonsIn(rowOf("Pending Pat"))).toEqual(["Approve", "Reject", "Reschedule", "Cancel"]);
    expect(buttonsIn(rowOf("Waiting Wes"))).toEqual(["Cancel"]);
    expect(buttonsIn(rowOf("Cancelled Cy"))).toEqual([]);
    expect(buttonsIn(rowOf("Failed Fay"))).toEqual(["Reschedule", "Cancel", "Retry sync"]);
    expect(rowOf("Waiting Wes")).toHaveTextContent("₹500");
  });

  it("filters by status chip (deep-linkable) and by search text", async () => {
    open("appointments/needs-approval", { "GET /v1/consultant/appointments": { appointments: list } });
    await screen.findByText("Pending Pat");
    expect(screen.queryByText("Waiting Wes")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "All" }));
    expect(await screen.findByText("Waiting Wes")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Search appointments"), "cy");
    expect(screen.queryByText("Waiting Wes")).toBeNull();
    expect(screen.getByText("Cancelled Cy")).toBeInTheDocument();
  });

  it("approves and reloads", async () => {
    let status = "PENDING_CONFIRMATION";
    const api = open("appointments/all", {
      "GET /v1/consultant/appointments": () => ({ appointments: [appt({ id: "p", patient_name: "Pending Pat", status: status as never })] }),
      "POST /v1/consultant/appointments/p/approve": () => { status = "CONFIRMED"; return {}; },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).toBeNull());
    expect(api.find("POST", "/v1/consultant/appointments/p/approve")).toHaveLength(1);
  });

  it("rejects with an optional reason", async () => {
    const api = open("appointments/all", { "GET /v1/consultant/appointments": { appointments: [list[0]] }, "POST /v1/consultant/appointments/p/reject": {} });
    await userEvent.click(await screen.findByRole("button", { name: "Reject" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/Reason/), "Doctor is on leave");
    await userEvent.click(within(dialog).getByRole("button", { name: "Reject request" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.find("POST", "/v1/consultant/appointments/p/reject")[0].body).toEqual({ reason: "Doctor is on leave" });
  });

  it("shows the server's error if an action fails", async () => {
    open("appointments/all", { "GET /v1/consultant/appointments": { appointments: [list[0]] }, "POST /v1/consultant/appointments/p/approve": { status: 409, body: { error: "This appointment was already updated elsewhere" } } });
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already updated elsewhere");
  });

  describe("reschedule with the date-time picker", () => {
    // a1 starts 2031-01-01T10:00:00Z = Wed 1 Jan 15:30 in the clinic's zone (Asia/Kolkata)
    const CHECK_OK = { startAt: "", endAt: "", inPast: false, withinHours: true, onGrid: true, serviceBufferMinutes: 5, serviceStepMinutes: 35, hours: { start: "09:00", end: "17:00" }, conflicts: [], tight: [] };
    const openModal = async (check: unknown, extra: Record<string, unknown> = {}) => {
      const api = open("appointments/all", {
        "GET /v1/consultant/appointments": { appointments: [list[0]] },
        "GET /v1/consultant/slots/check": check,
        "POST /v1/consultant/appointments/p/reschedule": {},
        ...extra,
      });
      await userEvent.click(await screen.findByRole("button", { name: "Reschedule" }));
      return { api, dialog: await screen.findByRole("dialog") };
    };
    const pickDay = (dialog: HTMLElement) => userEvent.click(dialog.querySelector<HTMLElement>('[data-date="2031-01-02"]')!); // Thu 2 Jan

    it("starts on the current time and asks for a new one before anything can be saved", async () => {
      const { api, dialog } = await openModal(CHECK_OK);
      expect(within(dialog).getByRole("combobox", { name: "Hour" })).toHaveValue("3");
      expect(within(dialog).getByRole("combobox", { name: "Minute" })).toHaveValue("30");
      expect(within(dialog).getByRole("button", { name: "PM" })).toHaveAttribute("aria-pressed", "true");
      expect(within(dialog).getByText("Pick a new date and time.")).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: "Move appointment" })).toBeDisabled();
      expect(api.find("GET", "/v1/consultant/slots/check")).toHaveLength(0);
    });

    it("moves the appointment to any picked date and minute, interpreting the time in the clinic's zone", async () => {
      const { api, dialog } = await openModal(CHECK_OK);
      await pickDay(dialog); // Thu 2 Jan
      await userEvent.selectOptions(within(dialog).getByRole("combobox", { name: "Minute" }), "45");
      expect(await within(dialog).findByText("Free — inside working hours.")).toBeInTheDocument();
      const check = new URLSearchParams(api.find("GET", "/v1/consultant/slots/check").at(-1)!.query);
      expect(check.get("startAt")).toBe("2031-01-02T10:15:00.000Z"); // 15:45 IST
      expect(check.get("excludeAppointmentId")).toBe("p");
      expect(check.get("serviceId")).toBe("s1");
      expect(check.get("resourceId")).toBe("r1");

      await userEvent.click(within(dialog).getByRole("button", { name: /^Move to/ }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(api.find("POST", "/v1/consultant/appointments/p/reschedule")[0].body).toEqual({ startAt: "2031-01-02T10:15:00.000Z" });
    });

    it("warns about, but allows, a time outside working hours", async () => {
      const { dialog } = await openModal({ ...CHECK_OK, withinHours: false });
      await pickDay(dialog);
      expect(await within(dialog).findByText(/Outside Dr Rao's usual hours \(09:00–17:00\)/)).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: /^Move to/ })).toBeEnabled();
    });

    it("says when the practitioner doesn't work that day at all", async () => {
      const { dialog } = await openModal({ ...CHECK_OK, withinHours: false, hours: null });
      await pickDay(dialog);
      expect(await within(dialog).findByText(/isn't normally working that day/)).toBeInTheDocument();
    });

    it("blocks a time that overlaps another booking", async () => {
      const { api, dialog } = await openModal({ ...CHECK_OK, conflicts: [{ id: "x", patientName: "Neha Iyer", startAt: "2031-01-02T10:00:00Z", endAt: "2031-01-02T10:30:00Z" }] });
      await pickDay(dialog);
      expect(await within(dialog).findByText(/Overlaps Neha Iyer/)).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: /^Move to/ })).toBeDisabled();
      expect(api.find("POST", "/v1/consultant/appointments/p/reschedule")).toHaveLength(0);
    });

    it("warns, without blocking, when a time is inside another visit's gap — after it or before it", async () => {
      const after = { id: "x", patientName: "Neha Iyer", startAt: "2031-01-02T09:00:00Z", endAt: "2031-01-02T09:30:00Z", bufferMinutes: 15 };
      const { dialog } = await openModal({ ...CHECK_OK, tight: [after] });
      await pickDay(dialog); // 15:30 IST = 10:00Z, after the visit that ended 09:30Z
      expect(await within(dialog).findByText(/Right after Neha Iyer's visit \(ends .*\); that service keeps a 15-minute gap/)).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: /^Move to/ })).toBeEnabled();
    });

    it("warns about the gap before the next visit using the moved service's own buffer", async () => {
      const next = { id: "y", patientName: "Vikram Shah", startAt: "2031-01-02T10:10:00Z", endAt: "2031-01-02T10:40:00Z", bufferMinutes: 5 };
      const { dialog } = await openModal({ ...CHECK_OK, serviceBufferMinutes: 20, tight: [next] });
      await pickDay(dialog); // starts 10:00Z, the visit at 10:10Z follows
      expect(await within(dialog).findByText(/Right before Vikram Shah's visit .*this service keeps a 20-minute gap after each visit/)).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: /^Move to/ })).toBeEnabled();
    });

    it("mentions when a time isn't one of the usual start times, but still allows it", async () => {
      const { dialog } = await openModal({ ...CHECK_OK, onGrid: false });
      await pickDay(dialog);
      expect(await within(dialog).findByText(/Not one of the usual start times for this service \(every 35 minutes from opening\)/)).toBeInTheDocument();
      expect(within(dialog).getByText("Free — inside working hours.")).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: /^Move to/ })).toBeEnabled();
    });

    it("blocks a time in the past", async () => {
      const { dialog } = await openModal({ ...CHECK_OK, inPast: true });
      await pickDay(dialog);
      expect(await within(dialog).findByText("That time has already passed.")).toBeInTheDocument();
      expect(within(dialog).getByRole("button", { name: /^Move to/ })).toBeDisabled();
    });

    it("keeps the dialog open and shows the server's error if saving fails", async () => {
      const { dialog } = await openModal(CHECK_OK, { "POST /v1/consultant/appointments/p/reschedule": { status: 409, body: { error: "That time was just taken by someone else" } } });
      await pickDay(dialog);
      await userEvent.click(await within(dialog).findByRole("button", { name: /^Move to/ }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("just taken by someone else");
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    it("lets the consultant pick any 5-minute time", async () => {
      tokens.set("jwt");
      window.location.hash = "#/appointments/all";
      mockApi({ "GET /v1/consultant/settings": { settings: SETTINGS }, "GET /v1/consultant/appointments": { appointments: [list[0]] } });
      render(<App />);
      await screen.findByText("Pending Pat");
      await userEvent.click(screen.getByRole("button", { name: "Reschedule" }));
      const minutes = within(await screen.findByRole("dialog")).getByRole("combobox", { name: "Minute" });
      expect(Array.from(minutes.querySelectorAll("option"))).toHaveLength(12);
    });
  });

  it("shows times in the clinic's time zone, not the browser's", async () => {
    tokens.set("jwt");
    window.location.hash = "#/appointments/all";
    mockApi({ "GET /v1/consultant/settings": { settings: { ...SETTINGS, timezone: "America/New_York" } }, "GET /v1/consultant/appointments": { appointments: [appt({ patient_name: "Zoned Zed", start_at: "2031-01-01T10:00:00Z" })] } });
    render(<App />);
    const row = (await screen.findByText("Zoned Zed")).closest("tr")!;
    await waitFor(() => expect(row).toHaveTextContent(/5:00\s*am/i)); // 10:00Z is 05:00 EST, whatever zone this machine is in
  });

  it("exports the filtered rows as a CSV file", async () => {
    const created: Blob[] = [];
    vi.stubGlobal("URL", { createObjectURL: (b: Blob) => (created.push(b), "blob:x"), revokeObjectURL: () => undefined });
    HTMLAnchorElement.prototype.click = vi.fn();
    open("appointments/needs-approval", { "GET /v1/consultant/appointments": { appointments: list } });
    await screen.findByText("Pending Pat");
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    const text = await created[0].text();
    expect(text).toContain("Pending Pat");
    expect(text).not.toContain("Waiting Wes"); // only what's on screen
  });

  it("renders user-supplied names as text, never as HTML", async () => {
    const { container } = render(<div />); void container;
    open("appointments/all", { "GET /v1/consultant/appointments": { appointments: [appt({ patient_name: '<img src=x onerror="window.__pwned=1">' })] } });
    await screen.findByText('<img src=x onerror="window.__pwned=1">');
    expect(document.querySelector("img")).toBeNull();
  });

  it("CSV cells that look like spreadsheet formulas are neutralised", () => {
    expect(toCsv([["=HYPERLINK(\"x\")", "ok", 'say "hi"']])).toBe(`"'=HYPERLINK(""x"")","ok","say ""hi"""`);
  });
});

describe("users", () => {
  const USER = { id: "u1", name: "Asha Rao", phone: "+919000000001", phoneNormalized: "919000000001", phoneVerified: true, email: "asha@example.com", dateOfBirth: null, preferredLanguage: "Hindi", firstChannel: "whatsapp", firstSeenAt: "2030-01-01T00:00:00Z", lastSeenAt: "2030-02-01T00:00:00Z" };

  it("lists, searches and opens a user's history", async () => {
    const api = open("users", {
      "GET /v1/consultant/users": { users: [USER] },
      "GET /v1/consultant/users/u1": { user: USER, appointments: [{ id: "a", status: "CONFIRMED", start_at: "2031-01-01T10:00:00Z", channel: "web", service_name: "Consult", resource_name: "Dr Rao" }] },
    });
    expect(await screen.findByText("+919000000001", { exact: false })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Search users"), "asha");
    await waitFor(() => expect(api.find("GET", "/v1/consultant/users").some((c) => c.query.includes("q=asha"))).toBe(true));
    await userEvent.click(screen.getAllByText("Asha Rao")[0]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Consult with Dr Rao/)).toBeInTheDocument();
    expect(within(dialog).getByText("verified")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("explains the empty state", async () => {
    open("users", { "GET /v1/consultant/users": { users: [] } });
    expect(await screen.findByText(/No users yet/)).toBeInTheDocument();
  });
});

describe("services", () => {
  it("adds a service", async () => {
    let services = [SERVICE];
    const api = open("services", {
      "GET /v1/consultant/services": () => ({ services }),
      "POST /v1/consultant/services": (c: { body: { name: string } }) => { services = [...services, { ...SERVICE, id: "s2", name: c.body.name }]; return { service: services[1] }; },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Add service" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Follow-up");
    await userEvent.clear(within(dialog).getByLabelText(/Duration/));
    await userEvent.type(within(dialog).getByLabelText(/Duration/), "20");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add service" }));
    expect(await screen.findByText("Follow-up")).toBeInTheDocument();
    expect(api.find("POST", "/v1/consultant/services")[0].body).toEqual({ name: "Follow-up", durationMinutes: 20, bufferMinutes: 0 });
  });

  it("edits and turns a service off", async () => {
    const api = open("services", { "GET /v1/consultant/services": { services: [SERVICE] }, "PUT /v1/consultant/services/s1": {} });
    await userEvent.click(await screen.findByRole("button", { name: "Turn off" }));
    expect(api.find("PUT", "/v1/consultant/services/s1")[0].body).toEqual({ active: false });
    await userEvent.click(screen.getByRole("button", { name: "Edit" }));
    await userEvent.clear(screen.getByLabelText(/Duration/));
    await userEvent.type(screen.getByLabelText(/Duration/), "45");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.find("PUT", "/v1/consultant/services/s1")).toHaveLength(2));
    expect(api.find("PUT", "/v1/consultant/services/s1")[1].body).toEqual({ name: "Consult", durationMinutes: 45, bufferMinutes: 5 });
  });

  it("shows the server's validation error in the form", async () => {
    open("services", { "GET /v1/consultant/services": { services: [] }, "POST /v1/consultant/services": { status: 400, body: { error: "durationMinutes: Number must be greater than or equal to 5" } } });
    await userEvent.click(await screen.findByRole("button", { name: "Add service" }));
    await userEvent.type(screen.getByLabelText("Name"), "Quick");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add service" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("greater than or equal to 5");
  });
});

describe("practitioners", () => {
  it("edits weekly hours and holidays, saving one schedule", async () => {
    const api = open("practitioners", {
      "GET /v1/consultant/resources": { resources: [RESOURCE] },
      "GET /v1/consultant/resources/r1/availability": { weekly: [{ weekday: 1, start: "09:00", end: "17:00" }], exceptions: [{ date: "2031-12-25", closed: true }] },
      "PUT /v1/consultant/resources/r1/availability": {},
    });
    await userEvent.click(await screen.findByRole("button", { name: "Working hours" }));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByLabelText("Monday opens")).toHaveValue("09:00");
    expect(within(dialog).getByLabelText("Tuesday opens")).toBeDisabled();

    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Tuesday/ }));
    fireTimeChange(within(dialog).getByLabelText("Tuesday closes"), "13:00");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save hours" }));
    expect(await within(dialog).findByText(/Saved/)).toBeInTheDocument();
    expect(api.find("PUT", "/v1/consultant/resources/r1/availability")[0].body).toEqual({
      weekly: [{ weekday: 1, start: "09:00", end: "17:00" }, { weekday: 2, start: "09:00", end: "13:00" }],
      exceptions: [{ date: "2031-12-25", closed: true }],
    });
  });

  it("adds a practitioner", async () => {
    const api = open("practitioners", { "GET /v1/consultant/resources": { resources: [] }, "POST /v1/consultant/resources": { resource: RESOURCE } });
    expect(await screen.findByText(/No practitioners yet/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add practitioner" }));
    await userEvent.type(screen.getByLabelText("Name"), "Dr. Rao");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add practitioner" }));
    await waitFor(() => expect(api.find("POST", "/v1/consultant/resources")[0].body).toEqual({ name: "Dr. Rao" }));
  });

  it("shows the Google Calendar connect link, or explains why it can't", async () => {
    open("practitioners", { "GET /v1/consultant/resources": { resources: [RESOURCE] }, "GET /v1/consultant/resources/r1/connect-link": { url: "https://server/auth/google/start?token=abc", expiresInMinutes: 20 } });
    await userEvent.click(await screen.findByRole("button", { name: "Connect Google Calendar" }));
    expect(await screen.findByText("https://server/auth/google/start?token=abc")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open link" })).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("surfaces the server's reason when Google isn't configured", async () => {
    open("practitioners", { "GET /v1/consultant/resources": { resources: [RESOURCE] }, "GET /v1/consultant/resources/r1/connect-link": { status: 400, body: { error: "Google Calendar is not configured on the server" } } });
    await userEvent.click(await screen.findByRole("button", { name: "Connect Google Calendar" }));
    expect(await screen.findByText("Google Calendar is not configured on the server")).toBeInTheDocument();
  });
});

function fireTimeChange(el: HTMLElement, value: string) {
  // <input type=time> doesn't take typed text in jsdom; set the value the way React listens for it.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("payments", () => {
  const TX = { id: "t1", status: "paid", amount_paise: 50000, band: "weekday", created_at: "2031-01-01T00:00:00Z", paid_at: "2031-01-01T00:05:00Z", razorpay_payment_id: "pay_123", appointment_id: "a1", start_at: "2031-01-02T10:00:00Z", patient_name: "Asha Rao", patient_phone: "+919000000001", service_name: "Consult" };

  it("explains that the admin must enable payments, and offers no fee form", async () => {
    open("payments", { "GET /v1/consultant/payments": { payments: { available: false, collectPayments: false, currency: "INR", pricing: null, note: "Ask the admin to connect Razorpay." } }, "GET /v1/consultant/payments/transactions": { transactions: [] } });
    expect(await screen.findByText("Ask the admin to connect Razorpay.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save fees" })).toBeNull();
  });

  it("saves a flat hourly fee", async () => {
    const api = open("payments", { "GET /v1/consultant/payments": { payments: { available: true, collectPayments: false, currency: "INR", pricing: null } }, "GET /v1/consultant/payments/transactions": { transactions: [] }, "PUT /v1/consultant/payments": {} });
    await userEvent.click(await screen.findByLabelText(/Collect payment/));
    await userEvent.type(screen.getByLabelText(/Fee per hour/), "1000");
    await userEvent.click(screen.getByRole("button", { name: "Save fees" }));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(api.find("PUT", "/v1/consultant/payments")[0].body).toEqual({ collectPayments: true, pricing: { mode: "flat", hourlyRate: 1000 } });
  });

  it("saves weekday / weekend / night fees and loads saved ones", async () => {
    const api = open("payments", { "GET /v1/consultant/payments": { payments: { available: true, collectPayments: true, currency: "INR", pricing: { mode: "flat", hourlyRate: 750 } } }, "GET /v1/consultant/payments/transactions": { transactions: [] }, "PUT /v1/consultant/payments": {} });
    expect(await screen.findByLabelText(/Fee per hour/)).toHaveValue(750);
    await userEvent.click(screen.getByLabelText(/Different fees/));
    await userEvent.type(screen.getByLabelText(/Weekday/), "1000");
    await userEvent.type(screen.getByLabelText(/Weekend/), "1500");
    await userEvent.type(screen.getByLabelText(/Night ₹/), "2000");
    await userEvent.click(screen.getByRole("button", { name: "Save fees" }));
    await screen.findByText("Saved.");
    expect(api.find("PUT", "/v1/consultant/payments")[0].body).toEqual({ collectPayments: true, pricing: { mode: "variable", weekdayRate: 1000, weekendRate: 1500, nightRate: 2000, nightStart: "20:00", nightEnd: "06:00" } });
  });

  it("lists transactions with a paid total", async () => {
    open("payments", { "GET /v1/consultant/payments": { payments: { available: true, collectPayments: true, currency: "INR", pricing: { mode: "flat", hourlyRate: 1 } } }, "GET /v1/consultant/payments/transactions": { transactions: [TX] } });
    expect(await screen.findByText("pay_123")).toBeInTheDocument();
    expect(screen.getByText("1 paid · ₹500")).toBeInTheDocument();
  });

  it("toPricing builds the API shape for each mode", () => {
    const base = { collect: true, flat: "5", weekday: "1", weekend: "2", night: "3", nightStart: "21:00", nightEnd: "05:00" };
    expect(toPricing({ ...base, mode: "flat" })).toEqual({ mode: "flat", hourlyRate: 5 });
    expect(toPricing({ ...base, mode: "variable" })).toEqual({ mode: "variable", weekdayRate: 1, weekendRate: 2, nightRate: 3, nightStart: "21:00", nightEnd: "05:00" });
  });
});

describe("settings", () => {
  it("saves the booking flow and clinic details, showing server warnings", async () => {
    const api = open("settings", {
      "PUT /v1/consultant/settings": { settings: { ...SETTINGS, name: "Renamed Clinic", confirmationPolicy: "instant" }, warnings: ["whatsappPhoneNumberId is not set"] },
    });
    await userEvent.click(await screen.findByLabelText(/Direct booking/));
    const name = screen.getByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Renamed Clinic");
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(screen.getByText("whatsappPhoneNumberId is not set")).toBeInTheDocument();
    expect(api.find("PUT", "/v1/consultant/settings")[0].body).toMatchObject({ name: "Renamed Clinic", confirmationPolicy: "instant", staffWhatsappNumber: null, reminderHoursBefore: 24 });
    expect(await screen.findByText("Renamed Clinic", { selector: ".muted" })).toBeInTheDocument(); // sidebar picks up the new name
  });

  it("changes the password, and shows why it fails", async () => {
    const api = open("settings", { "POST /v1/consultant/account/password": (c: { body: { currentPassword: string } }) => (c.body.currentPassword === "right-one" ? {} : { status: 400, body: { error: "Current password is incorrect" } }) });
    await screen.findByRole("heading", { name: "Change your password" });
    await userEvent.type(screen.getByLabelText("Current password"), "wrong");
    await userEvent.type(screen.getByLabelText("New password"), "new-password-1");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("Current password is incorrect")).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText("Current password"));
    await userEvent.type(screen.getByLabelText("Current password"), "right-one");
    await userEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText("Password changed.")).toBeInTheDocument();
    expect(api.find("POST", "/v1/consultant/account/password")).toHaveLength(2);
  });
});

describe("settings no longer have a slot interval", () => {
  it("doesn't show one, and doesn't send one when saving", async () => {
    const api = open("settings", { "PUT /v1/consultant/settings": { settings: SETTINGS } });
    expect(await screen.findByRole("button", { name: "Save settings" })).toBeInTheDocument();
    expect(screen.queryByText(/slot interval/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(api.find("PUT", "/v1/consultant/settings")).toHaveLength(1));
    expect(api.find("PUT", "/v1/consultant/settings")[0].body).not.toHaveProperty("slotIntervalMinutes");
  });
});

describe("login screens point at each other", () => {
  it("the consultant login links to the admin console", async () => {
    mockApi({});
    render(<App />);
    expect(await screen.findByRole("link", { name: "Open the admin console" })).toHaveAttribute("href", "/admin/");
  });
});

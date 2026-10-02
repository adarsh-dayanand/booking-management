import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { toPricing } from "./components/FeesCard";
import { tokenStore } from "./api";
import type { Appointment } from "./types";

type Handler = (url: string, init?: RequestInit) => { status?: number; body: unknown };
let handler: Handler;
const calls: { url: string; method: string; body?: unknown; auth?: string }[] = [];

beforeEach(() => {
  localStorage.clear();
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url, method: init.method ?? "GET",
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        auth: (init.headers as Record<string, string>)?.Authorization,
      });
      const { status = 200, body } = handler(url, init);
      return new Response(JSON.stringify(body), { status });
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const appt = (over: Partial<Appointment> = {}): Appointment => ({
  id: "a1", start_at: "2031-01-01T10:00:00Z", patient_name: "Asha", patient_phone: "+919000000001", service_name: "Consult",
  resource_name: "Dr Rao", channel: "web", status: "CONFIRMED", payment_status: null, amount_paise: null, calendar_sync_status: "synced", ...over,
});

const serve = (appointments: Appointment[], payments: object): Handler => (url) => {
  if (url.endsWith("/appointments")) return { body: { appointments } };
  if (url.endsWith("/payments")) return { body: { payments } };
  return { body: {} };
};
const unavailable = { available: false, collectPayments: false, currency: "INR", pricing: null, note: "Ask the admin to connect Razorpay." };
const available = { available: true, collectPayments: false, currency: "INR", pricing: null };

describe("login", () => {
  it("logs in, stores the token, and shows the dashboard", async () => {
    handler = (url) => (url.endsWith("/login") ? { body: { token: "jwt-1" } } : serve([], unavailable)(url));
    render(<App />);
    await userEvent.type(screen.getByLabelText("Email"), "owner@demo-clinic.test");
    await userEvent.type(screen.getByLabelText("Password"), "pw");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("Appointments")).toBeInTheDocument();
    expect(tokenStore.get()).toBe("jwt-1");
    expect(calls[0]).toMatchObject({ url: "/v1/consultant/login", method: "POST", body: { email: "owner@demo-clinic.test", password: "pw" }, auth: undefined });
  });

  it("shows the server's error for bad credentials", async () => {
    handler = () => ({ status: 401, body: { error: "Invalid email or password" } });
    render(<App />);
    await userEvent.type(screen.getByLabelText("Email"), "a@b.co");
    await userEvent.type(screen.getByLabelText("Password"), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Log in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password");
    expect(tokenStore.get()).toBeNull();
  });

  it("keeps an existing session (same token key as the old dashboard) and sends it as a bearer token", async () => {
    tokenStore.set("old-session");
    handler = serve([], unavailable);
    render(<App />);
    await screen.findByText("Appointments");
    expect(calls.every((c) => c.auth === "Bearer old-session")).toBe(true);
  });

  it("drops back to the login screen when the session has expired", async () => {
    tokenStore.set("expired");
    handler = () => ({ status: 401, body: { error: "Invalid or expired token" } });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Consultant login" })).toBeInTheDocument();
    expect(tokenStore.get()).toBeNull();
  });

  it("logs out", async () => {
    tokenStore.set("t");
    handler = serve([], unavailable);
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Log out" }));
    expect(screen.getByRole("heading", { name: "Consultant login" })).toBeInTheDocument();
    expect(tokenStore.get()).toBeNull();
  });
});

describe("appointments", () => {
  beforeEach(() => tokenStore.set("t"));

  it("offers the right actions for each status", async () => {
    handler = serve(
      [
        appt({ id: "p", status: "PENDING_CONFIRMATION" }),
        appt({ id: "w", status: "AWAITING_PAYMENT", payment_status: "created", amount_paise: 50000 }),
        appt({ id: "c", status: "CANCELLED" }),
        appt({ id: "f", status: "CONFIRMED", calendar_sync_status: "failed" }),
      ],
      unavailable
    );
    render(<App />);
    await screen.findByText("AWAITING_PAYMENT", { selector: ".status" });
    const rows = screen.getAllByRole("row").slice(1);
    const buttons = (i: number) => Array.from(rows[i].querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons(0)).toEqual(["Approve", "Reject", "Cancel"]);
    expect(buttons(1)).toEqual(["Cancel"]); // an unpaid hold can't be approved
    expect(buttons(2)).toEqual([]);
    expect(buttons(3)).toEqual(["Cancel", "Retry sync"]);
    expect(rows[1]).toHaveTextContent("created");
    expect(rows[1]).toHaveTextContent("₹500.00");
  });

  it("calls the API for an action and reloads", async () => {
    let list = [appt({ status: "PENDING_CONFIRMATION" })];
    handler = (url, init) => {
      if (init?.method === "POST") {
        list = [appt({ status: "CONFIRMED" })];
        return { body: {} };
      }
      return serve(list, unavailable)(url);
    };
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Approve" })).toBeNull());
    expect(calls.find((c) => c.method === "POST")?.url).toBe("/v1/consultant/appointments/a1/approve");
  });

  it("renders user-supplied names as text, never as HTML", async () => {
    handler = serve([appt({ patient_name: '<img src=x onerror="window.__pwned=1">' })], unavailable);
    const { container } = render(<App />);
    await screen.findByText('<img src=x onerror="window.__pwned=1">');
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("consultation fees", () => {
  beforeEach(() => tokenStore.set("t"));

  it("explains that the admin must enable payments, and offers no form", async () => {
    handler = serve([], unavailable);
    render(<App />);
    expect(await screen.findByText("Ask the admin to connect Razorpay.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save fees" })).toBeNull();
  });

  it("saves a flat hourly fee", async () => {
    handler = serve([], available);
    render(<App />);
    await userEvent.click(await screen.findByLabelText(/Collect payment/));
    await userEvent.type(screen.getByLabelText(/Fee per hour/), "1000");
    await userEvent.click(screen.getByRole("button", { name: "Save fees" }));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PUT")).toMatchObject({
      url: "/v1/consultant/payments",
      body: { collectPayments: true, pricing: { mode: "flat", hourlyRate: 1000 } },
    });
  });

  it("saves variable weekday / weekend / night fees", async () => {
    handler = serve([], available);
    render(<App />);
    await userEvent.click(await screen.findByLabelText(/Different fees/));
    await userEvent.type(screen.getByLabelText(/Weekday/), "1000");
    await userEvent.type(screen.getByLabelText(/Weekend/), "1500");
    await userEvent.type(screen.getByLabelText(/Night ₹/), "2000");
    await userEvent.click(screen.getByRole("button", { name: "Save fees" }));
    await screen.findByText("Saved.");
    expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
      collectPayments: false,
      pricing: { mode: "variable", weekdayRate: 1000, weekendRate: 1500, nightRate: 2000, nightStart: "20:00", nightEnd: "06:00" },
    });
  });

  it("loads the saved fees into the form and surfaces server validation errors", async () => {
    handler = (url, init) =>
      init?.method === "PUT"
        ? { status: 400, body: { error: "pricing.hourlyRate: Number must be greater than or equal to 0" } }
        : serve([], { ...available, collectPayments: true, pricing: { mode: "flat", hourlyRate: 750 } })(url);
    render(<App />);
    expect(await screen.findByLabelText(/Fee per hour/)).toHaveValue(750);
    expect(screen.getByLabelText(/Collect payment/)).toBeChecked();
    await userEvent.click(screen.getByRole("button", { name: "Save fees" }));
    expect(await screen.findByText(/greater than or equal to 0/)).toBeInTheDocument();
  });

  it("toPricing builds the API shape for each mode", () => {
    const base = { collect: true, flat: "5", weekday: "1", weekend: "2", night: "3", nightStart: "21:00", nightEnd: "05:00" };
    expect(toPricing({ ...base, mode: "flat" })).toEqual({ mode: "flat", hourlyRate: 5 });
    expect(toPricing({ ...base, mode: "variable" })).toEqual({ mode: "variable", weekdayRate: 1, weekendRate: 2, nightRate: 3, nightStart: "21:00", nightEnd: "05:00" });
  });
});

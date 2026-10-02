import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { tokens } from "./api";
import { runEmbeddedSignup } from "./facebook";
import { mockApi } from "../test-utils";
import type { WhatsAppInfo } from "./types";

const SETTINGS = { name: "Demo Clinic", timezone: "Asia/Kolkata", confirmationPolicy: "staff_approval", staffWhatsappNumber: null, reminderHoursBefore: 24, faqText: null, whatsappPhoneNumberId: null };
const NONE = { mode: "none", phoneNumberId: null, displayPhone: null, verifiedName: null, connectedAt: null, quality: null, template: null } as const;
const OWN = { mode: "own", phoneNumberId: "1440736872449106", displayPhone: "+91 98765 43210", verifiedName: "Sunrise Dental", connectedAt: "2030-01-01T00:00:00Z", quality: "GREEN", template: { name: "booking_update", status: "APPROVED" } } as const;
const info = (connection: WhatsAppInfo["connection"], available = true): WhatsAppInfo => ({ signup: { available, appId: available ? "1111" : null, configId: available ? "2222" : null, graphVersion: "v25.0" }, connection });

/** Stand-in for Meta's SDK + popup: login() reports a code, and facebook.com posts which number was chosen. */
function fakeFacebook(opts: { code?: string | null; session?: object | null; sessionEvent?: object } = {}) {
  const { code = "AUTH-CODE", session = { phone_number_id: "1440736872449106", waba_id: "1254054193543352" } } = opts;
  const login = vi.fn((cb: (r: { authResponse?: { code?: string } | null }) => void, _options?: Record<string, unknown>) => {
    setTimeout(() => {
      if (session) window.dispatchEvent(new MessageEvent("message", { origin: "https://www.facebook.com", data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: session }) }));
      if (opts.sessionEvent) window.dispatchEvent(new MessageEvent("message", { origin: "https://www.facebook.com", data: JSON.stringify(opts.sessionEvent) }));
      cb({ authResponse: code ? { code } : null });
    }, 0);
  });
  const init = vi.fn();
  window.FB = { init, login };
  return { login, init };
}

beforeEach(() => {
  localStorage.clear();
  delete window.FB;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.FB;
});

function open(connection: WhatsAppInfo["connection"], routes: Record<string, unknown> = {}, available = true) {
  tokens.set("jwt");
  window.location.hash = "#/whatsapp";
  const api = mockApi({ "GET /v1/consultant/settings": { settings: SETTINGS }, "GET /v1/consultant/whatsapp": info(connection, available), ...routes } as never);
  render(<App />);
  return api;
}

describe("WhatsApp page: connecting", () => {
  it("explains the requirements, including the warning about numbers already on the WhatsApp app", async () => {
    open(NONE);
    expect(await screen.findByRole("heading", { name: "Connect your WhatsApp number" })).toBeInTheDocument();
    expect(screen.getByText(/stop working there/)).toBeInTheDocument();
    expect(screen.getByText(/spare or new number, not your personal one/)).toBeInTheDocument();
  });

  it("opens Meta's popup with the platform's app and config, then sends the code and the chosen number to the server", async () => {
    const { login, init } = fakeFacebook();
    const connected = { ...OWN };
    let conn: WhatsAppInfo["connection"] = NONE;
    const api = open(NONE, {
      "GET /v1/consultant/whatsapp": () => info(conn),
      "POST /v1/consultant/whatsapp/connect": () => { conn = connected; return { status: 201, body: { warnings: [] } }; },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Connect WhatsApp number" }));

    await screen.findByText("WhatsApp is connected. Message your number from a phone to try it.");
    expect(init).toHaveBeenCalledWith({ appId: "1111", autoLogAppEvents: true, xfbml: true, version: "v25.0" });
    expect(login.mock.calls[0][1]).toMatchObject({ config_id: "2222", response_type: "code", override_default_response_type: true });
    expect(api.find("POST", "/v1/consultant/whatsapp/connect")[0].body).toEqual({ code: "AUTH-CODE", phoneNumberId: "1440736872449106", wabaId: "1254054193543352" });
    // the page now shows the connected number
    expect(await screen.findByText("+91 98765 43210")).toBeInTheDocument();
    expect(screen.getByText("Sunrise Dental")).toBeInTheDocument();
    expect(screen.getByText("approved")).toBeInTheDocument();
  });

  it("says why when the person cancels Meta's popup, and does not call the server", async () => {
    fakeFacebook({ code: null, session: null });
    const api = open(NONE, { "POST /v1/consultant/whatsapp/connect": {} });
    await userEvent.click(await screen.findByRole("button", { name: "Connect WhatsApp number" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("cancelled");
    expect(api.find("POST", "/v1/consultant/whatsapp/connect")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Connect WhatsApp number" })).toBeEnabled(); // can try again
  });

  it("shows the server's reason if connecting fails", async () => {
    fakeFacebook();
    open(NONE, { "POST /v1/consultant/whatsapp/connect": { status: 400, body: { error: "That WhatsApp number is already connected to another consultant" } } });
    await userEvent.click(await screen.findByRole("button", { name: "Connect WhatsApp number" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("already connected to another consultant");
  });

  it("connects but shows warnings, with a retry, when a follow-up step failed", async () => {
    fakeFacebook();
    let conn: WhatsAppInfo["connection"] = NONE;
    const api = open(NONE, {
      "GET /v1/consultant/whatsapp": () => info(conn),
      "POST /v1/consultant/whatsapp/connect": () => { conn = OWN; return { status: 201, body: { warnings: ["Couldn't register the number for messaging: add a payment method"] } }; },
      "POST /v1/consultant/whatsapp/repair": { warnings: [] },
    });
    await userEvent.click(await screen.findByRole("button", { name: "Connect WhatsApp number" }));
    expect(await screen.findByText(/Couldn't register the number for messaging/)).toBeInTheDocument();
    expect(screen.queryByText(/WhatsApp is connected/)).toBeNull();
    await userEvent.click(await screen.findByRole("button", { name: "Retry setup" }));
    await waitFor(() => expect(api.find("POST", "/v1/consultant/whatsapp/repair")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(/Couldn't register/)).toBeNull());
  });

  it("can't start when the platform hasn't set up WhatsApp sign-up, and says who to ask", async () => {
    open(NONE, {}, false);
    expect(await screen.findByText(/isn't enabled on this platform yet/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect WhatsApp number" })).toBeDisabled();
  });
});

describe("WhatsApp page: connected", () => {
  it("shows the number users see, template status and quality", async () => {
    open(OWN);
    expect(await screen.findByText("+91 98765 43210")).toBeInTheDocument();
    expect(screen.getByText("booking_update")).toBeInTheDocument();
    expect(screen.getByText("Green")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Connect your WhatsApp number" })).toBeNull();
  });

  it("warns that a template still pending approval limits reminders", async () => {
    open({ ...OWN, template: { name: "booking_update", status: "PENDING" } });
    expect(await screen.findByText(/need the template to be/)).toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();
  });

  it("disconnects only after confirming", async () => {
    window.confirm = vi.fn(() => false);
    let conn: WhatsAppInfo["connection"] = OWN;
    const api = open(OWN, { "GET /v1/consultant/whatsapp": () => info(conn), "DELETE /v1/consultant/whatsapp": () => { conn = NONE; return { status: 204 }; } });
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(api.find("DELETE", "/v1/consultant/whatsapp")).toHaveLength(0); // declined

    window.confirm = vi.fn(() => true);
    await userEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByRole("heading", { name: "Connect your WhatsApp number" })).toBeInTheDocument();
    expect(api.find("DELETE", "/v1/consultant/whatsapp")).toHaveLength(1);
  });

  it("a platform-operator number is shown, with the option to switch to the clinic's own", async () => {
    open({ ...NONE, mode: "platform", phoneNumberId: "1440736872449106", displayPhone: null });
    expect(await screen.findByText(/set up by the platform \(1440736872449106\)/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Use your own number instead" })).toBeInTheDocument();
  });
});

describe("Settings no longer asks for a WhatsApp phone number id", () => {
  it("has no such field, and doesn't send one", async () => {
    tokens.set("jwt");
    window.location.hash = "#/settings";
    const api = mockApi({ "GET /v1/consultant/settings": { settings: SETTINGS }, "PUT /v1/consultant/settings": { settings: SETTINGS } });
    render(<App />);
    await screen.findByRole("button", { name: "Save settings" });
    expect(screen.queryByLabelText(/WhatsApp phone number id/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() => expect(api.find("PUT", "/v1/consultant/settings")).toHaveLength(1));
    expect(api.find("PUT", "/v1/consultant/settings")[0].body).not.toHaveProperty("whatsappPhoneNumberId");
  });
});

describe("runEmbeddedSignup", () => {
  const config = { appId: "1", configId: "2", graphVersion: "v25.0" };

  it("works whichever arrives first: the code or the chosen number", async () => {
    window.FB = { init: vi.fn(), login: vi.fn((cb) => { cb({ authResponse: { code: "C" } }); setTimeout(() => window.dispatchEvent(new MessageEvent("message", { origin: "https://web.facebook.com", data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { phone_number_id: "11", waba_id: "22" } }) })), 0); }) };
    await expect(runEmbeddedSignup(config)).resolves.toEqual({ code: "C", phoneNumberId: "11", wabaId: "22" });
  });

  it("ignores 'which number' messages from any origin other than Facebook", async () => {
    window.FB = { init: vi.fn(), login: vi.fn((cb) => { window.dispatchEvent(new MessageEvent("message", { origin: "https://evil.example", data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: { phone_number_id: "666", waba_id: "666" } }) })); cb({ authResponse: { code: "C" } }); }) };
    await expect(runEmbeddedSignup(config, 60)).rejects.toThrow(/Timed out/); // the forged message was ignored, so it never completes
  });

  it("rejects when the person closes the popup or Meta reports an error", async () => {
    window.FB = { init: vi.fn(), login: vi.fn(() => setTimeout(() => window.dispatchEvent(new MessageEvent("message", { origin: "https://www.facebook.com", data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "CANCEL", data: { current_step: "PHONE_NUMBER_SETUP" } }) })), 0)) };
    await expect(runEmbeddedSignup(config)).rejects.toThrow("closed the WhatsApp sign-up");
    window.FB = { init: vi.fn(), login: vi.fn(() => setTimeout(() => window.dispatchEvent(new MessageEvent("message", { origin: "https://www.facebook.com", data: JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "ERROR", data: { error_message: "Number can't be verified" } }) })), 0)) };
    await expect(runEmbeddedSignup(config)).rejects.toThrow("Number can't be verified");
  });

  it("ignores unrelated and malformed window messages", async () => {
    window.FB = { init: vi.fn(), login: vi.fn((cb) => {
      for (const data of ["not json", JSON.stringify({ type: "something_else" }), JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH", data: {} })]) window.dispatchEvent(new MessageEvent("message", { origin: "https://www.facebook.com", data }));
      cb({ authResponse: { code: "C" } });
    }) };
    await expect(runEmbeddedSignup(config, 60)).rejects.toThrow(/Timed out/);
  });
});

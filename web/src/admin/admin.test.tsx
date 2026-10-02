import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { tokens } from "./api";
import { mockApi } from "../test-utils";
import { slugify } from "../shared/format";
import type { Consultant } from "./types";

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const OVERVIEW = { consultants: 3, paymentsEnabled: 1, appointments30d: 120, users: 480, revenue30dPaise: 7500000 };
const consultant = (over: Partial<Consultant> = {}): Consultant => ({
  slug: "demo-clinic", name: "Demo Clinic", timezone: "Asia/Kolkata", confirmationPolicy: "staff_approval", whatsappPhoneNumberId: null, whatsapp: { mode: "none", displayPhone: null, verifiedName: null, connectedAt: null }, createdAt: "2030-01-01T00:00:00Z",
  paymentsEnabled: false, razorpayKeyId: null, razorpayMode: null, keySecretConfigured: false, webhookSecretConfigured: false, consultantCollectsPayments: false,
  webhookUrl: "http://localhost:4000/v1/webhooks/razorpay/demo-clinic", counts: { appointments: 7, users: 5, logins: 1 }, ...over,
});

function open(page: string, routes: Record<string, unknown>) {
  tokens.set("admin-token");
  window.location.hash = `#/${page}`;
  const api = mockApi({ ...routes } as never);
  render(<App />);
  return api;
}

describe("admin token login", () => {
  it("links back to the consultant sign-in", () => {
    mockApi({});
    render(<App />);
    expect(screen.getByRole("link", { name: "Consultant sign-in" })).toHaveAttribute("href", "/consultant/");
  });

  it("accepts a valid token, stores it for this tab only, and shows the platform overview", async () => {
    const api = mockApi({ "GET /v1/admin/overview": OVERVIEW });
    render(<App />);
    await userEvent.type(screen.getByLabelText(/Admin token/), "  secret-token  ");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Platform overview" })).toBeInTheDocument();
    expect(sessionStorage.getItem("booking_admin_token")).toBe("secret-token");
    expect(localStorage.getItem("booking_admin_token")).toBeNull(); // not persisted beyond the tab
    expect(api.calls[0].auth).toBe("Bearer secret-token");
    expect(screen.getByText("480")).toBeInTheDocument();
  });

  it("explains a wrong token", async () => {
    mockApi({ "GET /v1/admin/overview": { status: 401, body: { error: "Invalid admin token" } } });
    render(<App />);
    await userEvent.type(screen.getByLabelText(/Admin token/), "nope");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That token isn't right");
    expect(tokens.get()).toBeNull();
  });

  it("explains that the admin API is switched off when the server has no ADMIN_TOKEN", async () => {
    mockApi({ "GET /v1/admin/overview": { status: 403, body: { error: "The admin API is disabled (set ADMIN_TOKEN)" } } });
    render(<App />);
    await userEvent.type(screen.getByLabelText(/Admin token/), "anything");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Set ADMIN_TOKEN");
  });

  it("returns to the login when the token stops working, and logs out", async () => {
    tokens.set("revoked");
    mockApi({ "GET /v1/admin/overview": { status: 401, body: { error: "Invalid admin token" } } });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Admin console" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Admin token/)).toBeInTheDocument();
    expect(tokens.get()).toBeNull();
  });

  it("logs out", async () => {
    open("overview", { "GET /v1/admin/overview": OVERVIEW });
    await userEvent.click(await screen.findByRole("button", { name: "Log out" }));
    expect(screen.getByLabelText(/Admin token/)).toBeInTheDocument();
    expect(tokens.get()).toBeNull();
  });
});

describe("consultants", () => {
  it("lists consultants with their payment state and usage", async () => {
    open("consultants", { "GET /v1/admin/tenants": { tenants: [consultant(), consultant({ slug: "live-clinic", name: "Live Clinic", paymentsEnabled: true, razorpayMode: "live" }), consultant({ slug: "test-clinic", name: "Test Clinic", paymentsEnabled: true, razorpayMode: "test" })] } });
    expect(await screen.findByText("Demo Clinic")).toBeInTheDocument();
    const rowOf = (n: string) => screen.getByText(n).closest("tr")!;
    expect(within(rowOf("Demo Clinic")).getByText("Off")).toBeInTheDocument();
    expect(within(rowOf("Live Clinic")).getByText("Live")).toBeInTheDocument();
    expect(within(rowOf("Test Clinic")).getByText("Test mode")).toBeInTheDocument();
    expect(within(rowOf("Demo Clinic")).getByText("7")).toBeInTheDocument();
  });

  it("onboards a consultant: slug follows the name, shows the first login's password once, and opens it", async () => {
    let tenants = [consultant()];
    const api = open("consultants", {
      "GET /v1/admin/tenants": () => ({ tenants }),
      "POST /v1/admin/tenants": (c: { body: { name: string; slug: string } }) => { tenants = [...tenants, consultant({ slug: c.body.slug, name: c.body.name })]; return { status: 201, body: { consultant: tenants[1] } }; },
      "GET /v1/admin/tenants/sunrise-dental-clinic": () => ({ consultant: tenants[1] }),
    });
    await userEvent.click(await screen.findByRole("button", { name: "New consultant" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Sunrise Dental Clinic");
    expect(within(dialog).getByLabelText(/Slug/)).toHaveValue("sunrise-dental-clinic");
    await userEvent.type(within(dialog).getByLabelText("Email"), "owner@sunrise.test");
    const password = (within(dialog).getByLabelText(/^Password/) as HTMLInputElement).value;
    expect(password).toHaveLength(12); // generated for the admin
    await userEvent.click(within(dialog).getByRole("button", { name: "Create consultant" }));

    expect(await screen.findByText("Consultant created")).toBeInTheDocument();
    expect(screen.getByText(password)).toBeInTheDocument();
    expect(api.find("POST", "/v1/admin/tenants")[0].body).toEqual({
      name: "Sunrise Dental Clinic", slug: "sunrise-dental-clinic", timezone: "Asia/Kolkata", confirmationPolicy: "staff_approval",
      owner: { email: "owner@sunrise.test", password },
    });
    await userEvent.click(screen.getByRole("button", { name: "Open consultant" }));
    expect(await screen.findByRole("heading", { name: "Sunrise Dental Clinic" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#/consultants/sunrise-dental-clinic");
  });

  it("shows who has connected their own WhatsApp number", async () => {
    const own = { mode: "own" as const, displayPhone: "+91 98765 43210", verifiedName: "Sunrise Dental", connectedAt: "2030-01-01T00:00:00Z" };
    open("consultants", { "GET /v1/admin/tenants": { tenants: [consultant({ whatsapp: own }), consultant({ slug: "p", name: "Platform Clinic", whatsapp: { ...own, mode: "platform" } }), consultant({ slug: "n", name: "No WA Clinic" })] } });
    await screen.findByText("Demo Clinic");
    const rowOf = (n: string) => screen.getByText(n).closest("tr")!;
    expect(within(rowOf("Demo Clinic")).getByText("Own number")).toBeInTheDocument();
    expect(within(rowOf("Platform Clinic")).getByText("Platform number")).toBeInTheDocument();
    expect(within(rowOf("No WA Clinic")).getByText("Not connected")).toBeInTheDocument();
  });

  it("keeps a slug the admin edited by hand", async () => {
    open("consultants", { "GET /v1/admin/tenants": { tenants: [] } });
    await userEvent.click(await screen.findByRole("button", { name: "New consultant" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText(/Slug/), "my-slug");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Different Name");
    expect(within(dialog).getByLabelText(/Slug/)).toHaveValue("my-slug");
  });

  it("shows the server's reason when creation is refused", async () => {
    open("consultants", { "GET /v1/admin/tenants": { tenants: [] }, "POST /v1/admin/tenants": { status: 400, body: { error: "That email is already used by another consultant login" } } });
    await userEvent.click(await screen.findByRole("button", { name: "New consultant" }));
    const dialog = screen.getByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Name"), "Another Clinic");
    await userEvent.type(within(dialog).getByLabelText("Email"), "taken@example.test");
    await userEvent.click(within(dialog).getByRole("button", { name: "Create consultant" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("already used by another consultant login");
    expect(screen.queryByText("Consultant created")).toBeNull();
  });

  it("slugify makes URL-safe slugs", () => {
    expect(slugify("  Dr. Rao's  Clinic & Spa! ")).toBe("dr-rao-s-clinic-spa");
  });
});

describe("consultant detail: payments", () => {
  const detail = (c: Consultant) => ({ "GET /v1/admin/tenants/demo-clinic": () => ({ consultant: c }) });

  it("enables payments with credentials and shows the webhook to register", async () => {
    let c = consultant();
    const api = open("consultants/demo-clinic", {
      "GET /v1/admin/tenants/demo-clinic": () => ({ consultant: c }),
      "PUT /v1/admin/tenants/demo-clinic/payments": () => { c = consultant({ paymentsEnabled: true, razorpayKeyId: "rzp_test_abc12345", razorpayMode: "test", keySecretConfigured: true, webhookSecretConfigured: true }); return { payments: c }; },
    });
    await screen.findByRole("heading", { name: "Demo Clinic" });
    expect(screen.getByText("http://localhost:4000/v1/webhooks/razorpay/demo-clinic")).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/Enable payments/));
    await userEvent.type(screen.getByLabelText(/Razorpay key id/), "rzp_test_abc12345");
    await userEvent.type(screen.getByLabelText(/Key secret/), "key-secret-123");
    await userEvent.type(screen.getByLabelText(/Webhook secret/), "whsec-secret-123");
    await userEvent.click(screen.getByRole("button", { name: "Save payments setup" }));
    expect(await screen.findByText(/Payments are enabled for this consultant/)).toBeInTheDocument();
    expect(api.find("PUT", "/v1/admin/tenants/demo-clinic/payments")[0].body).toEqual({
      enabled: true, razorpayKeyId: "rzp_test_abc12345", razorpayKeySecret: "key-secret-123", razorpayWebhookSecret: "whsec-secret-123",
    });
    // secrets are cleared from the form after saving and never come back from the server
    expect(screen.getByLabelText(/Key secret/)).toHaveValue("");
    await waitFor(() => expect(screen.getAllByPlaceholderText("•••••••• stored")).toHaveLength(2));
  });

  it("turning payments off sends only the flag — stored secrets are kept, not re-entered", async () => {
    const api = open("consultants/demo-clinic", {
      ...detail(consultant({ paymentsEnabled: true, razorpayKeyId: "rzp_test_abc12345", razorpayMode: "test", keySecretConfigured: true, webhookSecretConfigured: true })),
      "PUT /v1/admin/tenants/demo-clinic/payments": { payments: consultant() },
    });
    await screen.findByRole("heading", { name: "Demo Clinic" });
    expect(screen.getByLabelText(/Razorpay key id/)).toHaveValue("rzp_test_abc12345");
    expect(screen.getAllByPlaceholderText("•••••••• stored")).toHaveLength(2);
    await userEvent.click(screen.getByLabelText(/Enable payments/));
    await userEvent.click(screen.getByRole("button", { name: "Save payments setup" }));
    await waitFor(() => expect(api.find("PUT", "/v1/admin/tenants/demo-clinic/payments")).toHaveLength(1));
    expect(api.find("PUT", "/v1/admin/tenants/demo-clinic/payments")[0].body).toEqual({ enabled: false });
  });

  it("surfaces Razorpay's rejection of bad credentials", async () => {
    open("consultants/demo-clinic", { ...detail(consultant()), "PUT /v1/admin/tenants/demo-clinic/payments": { status: 400, body: { error: "Razorpay rejected these credentials. Check the key id and secret." } } });
    await screen.findByRole("heading", { name: "Demo Clinic" });
    await userEvent.type(screen.getByLabelText(/Razorpay key id/), "rzp_test_bad");
    await userEvent.type(screen.getByLabelText(/Key secret/), "wrong-secret-1");
    await userEvent.click(screen.getByRole("button", { name: "Save payments setup" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Razorpay rejected these credentials");
  });
});

describe("consultant detail: profile and logins", () => {
  it("edits the profile", async () => {
    const api = open("consultants/demo-clinic", { "GET /v1/admin/tenants/demo-clinic": { consultant: consultant() }, "PUT /v1/admin/tenants/demo-clinic": { consultant: consultant({ name: "Renamed" }) } });
    await screen.findByRole("heading", { name: "Demo Clinic" });
    await userEvent.click(screen.getByRole("tab", { name: "Profile" }));
    const name = screen.getByLabelText("Name");
    await userEvent.clear(name);
    await userEvent.type(name, "Renamed");
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
    expect(api.find("PUT", "/v1/admin/tenants/demo-clinic")[0].body).toEqual({ name: "Renamed", timezone: "Asia/Kolkata", whatsappPhoneNumberId: null });
  });

  it("locks the WhatsApp number id when the consultant connected their own, and doesn't send it", async () => {
    const own = { mode: "own" as const, displayPhone: "+91 98765 43210", verifiedName: "Sunrise Dental", connectedAt: "2030-01-01T00:00:00Z" };
    const api = open("consultants/demo-clinic", { "GET /v1/admin/tenants/demo-clinic": { consultant: consultant({ whatsapp: own, whatsappPhoneNumberId: "555000111" }) }, "PUT /v1/admin/tenants/demo-clinic": { consultant: consultant() } });
    await screen.findByRole("heading", { name: "Demo Clinic" });
    await userEvent.click(screen.getByRole("tab", { name: "Profile" }));
    expect(screen.getByLabelText(/WhatsApp phone number id/)).toBeDisabled();
    expect(screen.getByText(/Sunrise Dental/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await screen.findByText("Saved.");
    expect(api.find("PUT", "/v1/admin/tenants/demo-clinic")[0].body).toEqual({ name: "Demo Clinic", timezone: "Asia/Kolkata" });
  });

  it("adds a login, resets a password and removes one after confirming", async () => {
    let logins = [{ id: "l1", email: "owner@demo.test", createdAt: "2030-01-01T00:00:00Z" }];
    vi.stubGlobal("confirm", vi.fn(() => true));
    window.confirm = vi.fn(() => true);
    const api = open("consultants/demo-clinic", {
      "GET /v1/admin/tenants/demo-clinic": { consultant: consultant({ counts: { appointments: 0, users: 0, logins: 1 } }) },
      "GET /v1/admin/tenants/demo-clinic/users": () => ({ users: logins }),
      "POST /v1/admin/tenants/demo-clinic/users": (c: { body: { email: string } }) => { logins = [...logins, { id: "l2", email: c.body.email, createdAt: "2030-02-01T00:00:00Z" }]; return { status: 201, body: {} }; },
      "POST /v1/admin/tenants/demo-clinic/users/l1/password": {},
      "DELETE /v1/admin/tenants/demo-clinic/users/l2": () => { logins = logins.filter((l) => l.id !== "l2"); return { status: 204 }; },
    });
    await screen.findByRole("heading", { name: "Demo Clinic" });
    await userEvent.click(screen.getByRole("tab", { name: /Logins/ }));
    expect(await screen.findByText("owner@demo.test")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Add login" }));
    await userEvent.type(screen.getByLabelText("Email"), "nurse@demo.test");
    await userEvent.type(screen.getByLabelText(/^Password/), "nurse-pass-1");
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add login" }));
    expect(await screen.findByText("nurse@demo.test")).toBeInTheDocument();
    expect(api.find("POST", "/v1/admin/tenants/demo-clinic/users")[0].body).toEqual({ email: "nurse@demo.test", password: "nurse-pass-1" });

    await userEvent.click(screen.getAllByRole("button", { name: "Reset password" })[0]);
    await userEvent.type(screen.getByLabelText(/^New password/), "reset-pass-1");
    await userEvent.click(screen.getByRole("button", { name: "Set password" }));
    await waitFor(() => expect(api.find("POST", "/v1/admin/tenants/demo-clinic/users/l1/password")[0]?.body).toEqual({ password: "reset-pass-1" }));

    await userEvent.click(screen.getAllByRole("button", { name: "Remove" })[1]);
    await waitFor(() => expect(screen.queryByText("nurse@demo.test")).toBeNull());
    expect(window.confirm).toHaveBeenCalled();
  });

  it("shows why the last login can't be removed", async () => {
    window.confirm = vi.fn(() => true);
    open("consultants/demo-clinic", {
      "GET /v1/admin/tenants/demo-clinic": { consultant: consultant() },
      "GET /v1/admin/tenants/demo-clinic/users": { users: [{ id: "l1", email: "owner@demo.test", createdAt: "2030-01-01T00:00:00Z" }] },
      "DELETE /v1/admin/tenants/demo-clinic/users/l1": { status: 400, body: { error: "A consultant needs at least one login; add another first" } },
    });
    await screen.findByRole("heading", { name: "Demo Clinic" });
    await userEvent.click(screen.getByRole("tab", { name: /Logins/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("at least one login");
  });
});

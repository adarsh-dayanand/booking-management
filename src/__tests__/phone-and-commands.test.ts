import { describe, expect, it } from "vitest";
import { isPlausiblePhone, normalizePhone } from "../lib/phone";
import { isStaffNumber, parseStaffCommand } from "../channels/staffCommands";

describe("phone helpers", () => {
  it("normalises every way of typing the same number to one identity", () => {
    const canonical = "919876543210";
    for (const typed of ["+91 98765 43210", "9876543210", "09876543210", "0091 98765 43210", "91-98765-43210", "919876543210"]) {
      expect(normalizePhone(typed)).toBe(canonical);
    }
  });
  it("keeps other countries' numbers as given", () => {
    expect(normalizePhone("+1 (415) 555-0132")).toBe("14155550132");
    expect(normalizePhone("+44 7911 123456")).toBe("447911123456");
  });
  it("validates plausible lengths", () => {
    expect(isPlausiblePhone("+91 98765 43210")).toBe(true);
    expect(isPlausiblePhone("12345")).toBe(false);
  });
});

describe("staff WhatsApp commands", () => {
  it("parses approve/reject/cancel with refs and reasons", () => {
    expect(parseStaffCommand("APPROVE a1b2c3")).toEqual({ kind: "approve", ref: "a1b2c3" });
    expect(parseStaffCommand("yes #A1B2C3")).toEqual({ kind: "approve", ref: "a1b2c3" });
    expect(parseStaffCommand("reject a1b2c3 on leave that day")).toEqual({ kind: "reject", ref: "a1b2c3", reason: "on leave that day" });
    expect(parseStaffCommand("cancel a1b2c3")).toEqual({ kind: "cancel", ref: "a1b2c3", reason: undefined });
  });
  it("parses pending/connect and falls back to help", () => {
    expect(parseStaffCommand("pending")).toEqual({ kind: "pending" });
    expect(parseStaffCommand("connect calendar")).toEqual({ kind: "connect" });
    expect(parseStaffCommand("approve")).toEqual({ kind: "help" });
    expect(parseStaffCommand("approve zzzzzz")).toEqual({ kind: "help" });
    expect(parseStaffCommand("hello")).toEqual({ kind: "help" });
  });
  it("only accepts the registered staff number", () => {
    expect(isStaffNumber("919876543210", "9876543210")).toBe(false); // strict: a number without country code is not the staff number
    expect(isStaffNumber("919876543210", "+91 98765 43210")).toBe(true);
    expect(isStaffNumber(null, "919876543210")).toBe(false);
  });
});

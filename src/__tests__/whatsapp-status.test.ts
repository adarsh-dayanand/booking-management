import { describe, expect, it } from "vitest";
import { describeStatus } from "../channels/whatsapp";

describe("delivery status lines", () => {
  it("logs a delivered message briefly", () => {
    expect(describeStatus({ id: "wamid.HBgMOTE4ODYxMTIzODYwFQIAERgSOTAyMTU0NjhGRTZDNjQ1OUZBAA==", status: "delivered", recipient_id: "918861123860" })).toBe("[whatsapp] message …NjQ1OUZBAA== to +918861123860: delivered");
  });

  it("explains a failure with Meta's reason and what to do about it", () => {
    const line = describeStatus({ id: "wamid.X", status: "failed", recipient_id: "918861123860", errors: [{ code: 131030, title: "Recipient phone number not in allowed list", error_data: { details: "Add the number first" } }] })!;
    expect(line).toContain("FAILED (code 131030)");
    expect(line).toContain("Recipient phone number not in allowed list — Add the number first");
    expect(line).toContain("allowed list");
  });

  it("points at the token when it has expired", () => {
    expect(describeStatus({ id: "w", status: "failed", errors: [{ code: 190, title: "Access token expired" }] })).toContain("generate a new one");
  });

  it("copes with unknown codes and malformed updates", () => {
    expect(describeStatus({ id: "w", status: "failed", errors: [{ code: 999999, title: "Something new" }] })).toContain("Something new");
    expect(describeStatus({ id: "w", status: "failed" })).toContain("unknown error");
    expect(describeStatus({})).toBeNull();
    expect(describeStatus(null)).toBeNull();
  });
});

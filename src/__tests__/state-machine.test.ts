import { describe, expect, it } from "vitest";
import { canTransition } from "../booking/booking";
import type { AppointmentAction } from "../booking/booking";
import type { AppointmentStatus } from "../types";

const ALL_STATUSES: AppointmentStatus[] = ["PENDING_CONFIRMATION", "CONFIRMED", "REJECTED", "CANCELLED", "COMPLETED"];
const ALL_ACTIONS: AppointmentAction[] = ["APPROVE", "REJECT", "CANCEL", "RESCHEDULE"];

const ALLOWED: Record<AppointmentAction, AppointmentStatus[]> = {
  APPROVE: ["PENDING_CONFIRMATION"],
  REJECT: ["PENDING_CONFIRMATION"],
  CANCEL: ["PENDING_CONFIRMATION", "CONFIRMED"],
  RESCHEDULE: ["PENDING_CONFIRMATION", "CONFIRMED"],
};

describe("canTransition", () => {
  for (const action of ALL_ACTIONS) {
    for (const status of ALL_STATUSES) {
      const shouldAllow = ALLOWED[action].includes(status);
      it(`${shouldAllow ? "allows" : "rejects"} ${action} from ${status}`, () => {
        expect(canTransition(status, action)).toBe(shouldAllow);
      });
    }
  }
});

import { DateTime } from "luxon";
import { createConnectLink } from "../calendar/googleCalendar";
import * as booking from "../booking/booking";
import { isGoogleConfigured } from "../config";
import { pool } from "../lib/db";
import { AppError } from "../errors";
import { appointmentRef } from "./notify";
import { digitsOnly } from "../lib/phone";
import type { TenantConfig } from "../types";

export type StaffCommand =
  | { kind: "approve"; ref: string }
  | { kind: "reject"; ref: string; reason?: string }
  | { kind: "cancel"; ref: string; reason?: string }
  | { kind: "pending" }
  | { kind: "connect" }
  | { kind: "help" };

export function parseStaffCommand(text: string): StaffCommand {
  const t = text.trim();
  const m = t.match(/^(approve|accept|yes|reject|decline|cancel)\s+#?([0-9a-f]{6})\b\s*(.*)$/is);
  if (m) {
    const verb = m[1].toLowerCase();
    const ref = m[2].toLowerCase();
    const reason = m[3].trim() || undefined;
    if (verb === "approve" || verb === "accept" || verb === "yes") return { kind: "approve", ref };
    if (verb === "cancel") return { kind: "cancel", ref, reason };
    return { kind: "reject", ref, reason };
  }
  if (/^(pending|list|requests)\b/i.test(t)) return { kind: "pending" };
  if (/^(connect|calendar|connect calendar)\b/i.test(t)) return { kind: "connect" };
  return { kind: "help" };
}

/** Only the number the clinic registered as its staff number may run commands. */
export function isStaffNumber(staffNumber: string | null, from: string): boolean {
  return Boolean(staffNumber) && digitsOnly(staffNumber!) === digitsOnly(from);
}

const HELP = `Commands:
APPROVE <ref> — accept a pending request
REJECT <ref> <reason> — decline it
CANCEL <ref> <reason> — cancel a booking
PENDING — list requests waiting for you
CONNECT — get a link to connect your Google Calendar`;

async function resolveRef(tenantId: string, ref: string, statuses: string[]): Promise<string> {
  const result = await pool.query(
    `SELECT id FROM appointments WHERE tenant_id = $1 AND id::text LIKE $2 || '%' AND status = ANY($3::text[])`,
    [tenantId, ref, statuses]
  );
  if (result.rows.length === 0) throw new AppError(`No matching appointment for ref ${ref} (it may already be handled).`, 404);
  if (result.rows.length > 1) throw new AppError(`Ref ${ref} is ambiguous; use the dashboard.`, 409);
  return result.rows[0].id;
}

export async function handleStaffMessage(config: TenantConfig, text: string): Promise<string> {
  const cmd = parseStaffCommand(text);
  const tenantId = config.tenant.id;
  try {
    switch (cmd.kind) {
      case "approve": {
        const id = await resolveRef(tenantId, cmd.ref, ["PENDING_CONFIRMATION"]);
        await booking.approveAppointment(config, id, "staff");
        return `Accepted ${cmd.ref}. The patient has been notified.`;
      }
      case "reject": {
        const id = await resolveRef(tenantId, cmd.ref, ["PENDING_CONFIRMATION"]);
        await booking.rejectAppointment(config, id, cmd.reason, "staff");
        return `Declined ${cmd.ref}. The patient has been notified.`;
      }
      case "cancel": {
        const id = await resolveRef(tenantId, cmd.ref, ["PENDING_CONFIRMATION", "CONFIRMED"]);
        await booking.cancelAppointment(config, id, cmd.reason, "staff");
        return `Cancelled ${cmd.ref}. The patient has been notified.`;
      }
      case "pending": {
        const result = await pool.query(
          `SELECT a.id, a.start_at, COALESCE(a.patient_name, p.name) AS name, s.name AS service FROM appointments a
           JOIN patients p ON p.id = a.patient_id JOIN services s ON s.id = a.service_id
           WHERE a.tenant_id = $1 AND a.status = 'PENDING_CONFIRMATION' AND a.start_at > now()
           ORDER BY a.start_at LIMIT 15`,
          [tenantId]
        );
        if (result.rows.length === 0) return "No requests are waiting for you.";
        const lines = result.rows.map(
          (r) =>
            `${appointmentRef(r.id)} — ${r.name}, ${r.service}, ${DateTime.fromJSDate(new Date(r.start_at), { zone: config.tenant.timezone }).toFormat("ccc dd LLL h:mm a")}`
        );
        return `Waiting for you:\n${lines.join("\n")}\n\nReply APPROVE <ref> or REJECT <ref> <reason>.`;
      }
      case "connect": {
        if (!isGoogleConfigured) return "Google Calendar isn't configured on the server yet.";
        if (config.resources.length === 0) return "No practitioners are set up for this clinic.";
        const lines = config.resources.map((r) => {
          const status = r.googleConnectionStatus === "connected" ? " (already connected — open to reconnect)" : "";
          return `${r.name}${status}:\n${createConnectLink(r.id, tenantId)}`;
        });
        return `Open the link for each calendar and approve access (links expire in 20 minutes):\n\n${lines.join("\n\n")}`;
      }
      case "help":
        return HELP;
    }
  } catch (err) {
    if (err instanceof AppError) return err.message;
    console.error("[staffCommands] failed:", err);
    return "Something went wrong handling that. Please try the dashboard.";
  }
}

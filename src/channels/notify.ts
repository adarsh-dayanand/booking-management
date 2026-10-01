import { DateTime } from "luxon";
import { pool } from "../lib/db";
import * as whatsapp from "./whatsapp";

export type AppointmentEvent = "created" | "approved" | "rejected" | "cancelled" | "rescheduled" | "reminder";
/** Who caused the event. The actor is never messaged about their own action. */
export type Actor = "patient" | "staff" | "calendar" | "system";

export interface NotifyContext {
  ref: string;
  status: string;
  channel: string;
  patientName: string;
  patientPhone: string;
  serviceName: string;
  resourceName: string;
  clinicName: string;
  when: string;
  reason?: string | null;
}

export function appointmentRef(appointmentId: string): string {
  return appointmentId.slice(0, 6);
}

export function patientMessage(event: AppointmentEvent, actor: Actor, c: NotifyContext): string | null {
  const detail = `${c.serviceName} with ${c.resourceName}\n${c.when}\nRef: ${c.ref}`;
  const pending = c.status === "PENDING_CONFIRMATION";
  switch (event) {
    case "created":
      if (c.channel === "whatsapp") return null; // the agent's own reply already told them
      return pending
        ? `Hi ${c.patientName}, we've received your appointment request at ${c.clinicName}. The doctor will confirm it shortly.\n${detail}`
        : `Hi ${c.patientName}, your appointment at ${c.clinicName} is confirmed.\n${detail}`;
    case "approved":
      return `Good news ${c.patientName}: the doctor has confirmed your appointment at ${c.clinicName}.\n${detail}`;
    case "rejected":
      return `Sorry ${c.patientName}, the doctor couldn't accept your appointment request at ${c.clinicName}.${c.reason ? ` Reason: ${c.reason}.` : ""}\nYou're welcome to message us here to pick another time.\n${detail}`;
    case "cancelled":
      if (actor === "patient") return null;
      return `Hi ${c.patientName}, your appointment at ${c.clinicName} has been cancelled by the clinic.${c.reason ? ` Reason: ${c.reason}.` : ""}\nMessage us here to book another time.\n${detail}`;
    case "rescheduled":
      if (actor === "patient") return null;
      return `Hi ${c.patientName}, your appointment at ${c.clinicName} has been moved to a new time.${pending ? " It's awaiting the doctor's confirmation." : ""}\n${detail}\nReply here if that doesn't work for you.`;
    case "reminder":
      return `Reminder: ${c.patientName}, you have an appointment at ${c.clinicName}.\n${detail}\nReply here to reschedule or cancel.`;
  }
}

export function staffMessage(event: AppointmentEvent, actor: Actor, c: NotifyContext): string | null {
  if (actor !== "patient") return null; // staff/calendar changes were made by the doctor's side already
  const detail = `${c.patientName} (${c.patientPhone})\n${c.serviceName} with ${c.resourceName}\n${c.when}\nRef: ${c.ref}`;
  const pending = c.status === "PENDING_CONFIRMATION";
  const decide = `\nReply APPROVE ${c.ref} to accept or REJECT ${c.ref} <reason> to decline.`;
  switch (event) {
    case "created":
      return pending ? `New appointment request:\n${detail}${decide}` : `New booking (auto-confirmed):\n${detail}`;
    case "rescheduled":
      return pending ? `Patient moved their appointment — needs your acceptance again:\n${detail}${decide}` : `Patient rescheduled:\n${detail}`;
    case "cancelled":
      return `Patient cancelled:\n${detail}${c.reason ? `\nReason: ${c.reason}` : ""}`;
    default:
      return null;
  }
}

async function loadContext(appointmentId: string): Promise<{
  ctx: NotifyContext;
  phoneNumberId: string | null;
  staffNumber: string | null;
} | null> {
  const result = await pool.query(
    `SELECT a.id, a.status, a.channel, a.start_at, a.cancel_reason, a.rejected_reason,
            COALESCE(a.patient_name, p.name) AS patient_name, p.phone AS patient_phone, s.name AS service_name, r.name AS resource_name,
            t.name AS clinic_name, t.timezone, t.whatsapp_phone_number_id, t.staff_whatsapp_number
     FROM appointments a
     JOIN patients p ON p.id = a.patient_id
     JOIN services s ON s.id = a.service_id
     JOIN resources r ON r.id = a.resource_id
     JOIN tenants t ON t.id = a.tenant_id
     WHERE a.id = $1`,
    [appointmentId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ctx: {
      ref: appointmentRef(row.id),
      status: row.status,
      channel: row.channel,
      patientName: row.patient_name,
      patientPhone: row.patient_phone,
      serviceName: row.service_name,
      resourceName: row.resource_name,
      clinicName: row.clinic_name,
      when: DateTime.fromJSDate(new Date(row.start_at), { zone: row.timezone }).toFormat("ccc dd LLL yyyy, HH:mm"),
      reason: row.rejected_reason ?? row.cancel_reason,
    },
    phoneNumberId: row.whatsapp_phone_number_id,
    staffNumber: row.staff_whatsapp_number,
  };
}

/** Fail-soft: a notification problem must never undo or fail a booking. Returns the patient delivery result. */
export async function notifyAppointmentEvent(
  appointmentId: string,
  event: AppointmentEvent,
  actor: Actor
): Promise<whatsapp.DeliveryResult> {
  try {
    const loaded = await loadContext(appointmentId);
    if (!loaded) return "skipped";
    const { ctx, phoneNumberId, staffNumber } = loaded;

    const toStaff = staffMessage(event, actor, ctx);
    if (toStaff && staffNumber) await whatsapp.deliver(phoneNumberId, staffNumber, toStaff);

    const toPatient = patientMessage(event, actor, ctx);
    if (!toPatient) return "skipped";
    return await whatsapp.deliver(phoneNumberId, ctx.patientPhone.replace(/\D/g, ""), toPatient);
  } catch (err) {
    console.warn(`[notify] ${event} notification for ${appointmentId} failed:`, err);
    return "failed";
  }
}

export async function notifyStaff(tenantId: string, text: string): Promise<whatsapp.DeliveryResult> {
  const result = await pool.query(
    "SELECT whatsapp_phone_number_id, staff_whatsapp_number FROM tenants WHERE id = $1",
    [tenantId]
  );
  const row = result.rows[0];
  if (!row?.staff_whatsapp_number) return "skipped";
  return whatsapp.deliver(row.whatsapp_phone_number_id, row.staff_whatsapp_number, text);
}

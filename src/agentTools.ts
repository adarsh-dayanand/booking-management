import { DateTime } from "luxon";
import { z } from "zod";
import * as booking from "./booking";
import { pool } from "./db";
import { AppError, SlotConflictError } from "./errors";
import { notifyStaff } from "./notify";
import { digitsOnly, isPlausiblePhone, samePhone } from "./phone";
import type { Channel, TenantConfig } from "./types";

/** Per-conversation facts the agent can't be talked out of; persisted with the conversation. */
export interface AgentSession {
  /** Phone proven to belong to this chat: always set on WhatsApp, set on web only via verify_booking_reference. */
  verifiedPhone?: string;
  /** Appointments created in this very session (web visitors may manage those without further proof). */
  appointmentIds: string[];
  verifyAttempts: number;
}

export interface ToolContext {
  config: TenantConfig;
  channel: Channel;
  externalId: string;
  session: AgentSession;
}

type ToolResult = Record<string, unknown>;
interface Tool {
  declaration: { name: string; description: string; parameters: object };
  /** Writes change appointments; the agent loop uses this to avoid losing track of completed actions. */
  write: boolean;
  run: (args: any, ctx: ToolContext) => Promise<ToolResult>;
}

const uuid = z.string().uuid();
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const isoDateTime = z.string().datetime({ offset: true });

function identityPhone(ctx: ToolContext): string | undefined {
  return ctx.channel === "whatsapp" ? ctx.externalId : ctx.session.verifiedPhone;
}

const NOT_VERIFIED = {
  error:
    "Patient identity is not verified. Ask the patient for the phone number they booked with and their 6-character booking reference, then call verify_booking_reference.",
};

async function ownsAppointment(ctx: ToolContext, appointmentId: string): Promise<boolean> {
  if (ctx.session.appointmentIds.includes(appointmentId)) return true;
  const phone = identityPhone(ctx);
  if (!phone) return false;
  const result = await pool.query(
    `SELECT p.phone FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = $1 AND a.tenant_id = $2`,
    [appointmentId, ctx.config.tenant.id]
  );
  return result.rows.length > 0 && samePhone(result.rows[0].phone, phone);
}

function label(iso: string | Date, tz: string): string {
  const dt = iso instanceof Date ? DateTime.fromJSDate(iso, { zone: tz }) : DateTime.fromISO(iso, { zone: "utc" }).setZone(tz);
  return dt.toFormat("ccc dd LLL yyyy, HH:mm");
}

async function slotIsFree(ctx: ToolContext, resourceId: string, serviceId: string, start: Date): Promise<boolean> {
  // Re-derive availability (clinic hours + existing bookings + the doctor's live Google free/busy) rather than trusting the model's time.
  const slots = await booking.generateAvailableSlots(
    ctx.config, resourceId, serviceId, new Date(start.getTime() - 60_000), new Date(start.getTime() + 60_000)
  );
  return slots.some((s) => new Date(s.startAt).getTime() === start.getTime());
}

const PART_OF_DAY: Record<string, (hour: number) => boolean> = {
  morning: (h) => h < 12,
  afternoon: (h) => h >= 12 && h < 17,
  evening: (h) => h >= 17,
};

const tools: Tool[] = [
  {
    write: false,
    declaration: {
      name: "list_services",
      description: "List the services the clinic offers, with ids and durations.",
      parameters: { type: "object", properties: {} },
    },
    run: async (_args, ctx) => ({
      services: ctx.config.services.map((s) => ({ id: s.id, name: s.name, durationMinutes: s.durationMinutes })),
    }),
  },
  {
    write: false,
    declaration: {
      name: "list_practitioners",
      description: "List the doctors/practitioners patients can book with, with ids.",
      parameters: { type: "object", properties: {} },
    },
    run: async (_args, ctx) => ({ practitioners: ctx.config.resources.map((r) => ({ id: r.id, name: r.name })) }),
  },
  {
    write: false,
    declaration: {
      name: "get_available_slots",
      description:
        "Get bookable times, already checked against clinic hours, existing bookings and the doctor's live calendar. Only offer times returned here. Dates are in the clinic's local timezone.",
      parameters: {
        type: "object",
        properties: {
          serviceId: { type: "string", description: "Service id from list_services" },
          practitionerId: { type: "string", description: "Optional. Omit to search all practitioners." },
          fromDate: { type: "string", description: "YYYY-MM-DD, default today" },
          toDate: { type: "string", description: "YYYY-MM-DD, default two weeks after fromDate (max 21 days)" },
          partOfDay: { type: "string", enum: ["morning", "afternoon", "evening"] },
        },
        required: ["serviceId"],
      },
    },
    run: async (raw, ctx) => {
      const args = z
        .object({
          serviceId: uuid,
          practitionerId: uuid.optional(),
          fromDate: isoDate.optional(),
          toDate: isoDate.optional(),
          partOfDay: z.enum(["morning", "afternoon", "evening"]).optional(),
        })
        .parse(raw);
      const tz = ctx.config.tenant.timezone;
      const today = DateTime.now().setZone(tz).startOf("day");
      let from = args.fromDate ? DateTime.fromISO(args.fromDate, { zone: tz }).startOf("day") : today;
      if (from < today) from = today;
      let to = args.toDate ? DateTime.fromISO(args.toDate, { zone: tz }).endOf("day") : from.plus({ days: 13 }).endOf("day");
      if (to > from.plus({ days: 20 }).endOf("day")) to = from.plus({ days: 20 }).endOf("day");
      if (to < from) return { error: "toDate is before fromDate" };

      const practitioners = args.practitionerId
        ? ctx.config.resources.filter((r) => r.id === args.practitionerId)
        : ctx.config.resources;
      if (practitioners.length === 0) return { error: "Unknown practitioner" };

      const rangeStart = new Date(Math.max(from.toMillis(), Date.now()));
      const found: { practitionerId: string; practitionerName: string; startAt: string; local: string; day: string }[] = [];
      for (const r of practitioners) {
        const slots = await booking.generateAvailableSlots(ctx.config, r.id, args.serviceId, rangeStart, to.toJSDate());
        for (const s of slots) {
          const local = DateTime.fromISO(s.startAt, { zone: "utc" }).setZone(tz);
          if (args.partOfDay && !PART_OF_DAY[args.partOfDay](local.hour)) continue;
          found.push({
            practitionerId: r.id,
            practitionerName: r.name,
            startAt: s.startAt,
            local: local.toFormat("ccc dd LLL yyyy, HH:mm"),
            day: local.toISODate()!,
          });
        }
      }
      found.sort((a, b) => a.startAt.localeCompare(b.startAt));

      const singleDay = from.hasSame(to, "day");
      const perDay = new Map<string, number>();
      const picked = found
        .filter((s) => {
          const n = (perDay.get(s.day) ?? 0) + 1;
          perDay.set(s.day, n);
          return n <= (singleDay ? 8 : 4);
        })
        .slice(0, 12)
        .map(({ day: _day, ...rest }) => rest);
      return picked.length ? { slots: picked } : { slots: [], note: "No free times in that range. Offer to search other dates." };
    },
  },
  {
    write: true,
    declaration: {
      name: "book_appointment",
      description:
        "Book an appointment. Call ONLY after the patient has explicitly confirmed the service, practitioner, time and their name. startAt must be copied exactly from get_available_slots.",
      parameters: {
        type: "object",
        properties: {
          serviceId: { type: "string" },
          practitionerId: { type: "string" },
          startAt: { type: "string", description: "ISO timestamp exactly as returned by get_available_slots" },
          patientName: { type: "string" },
          patientPhone: { type: "string", description: "Required on web chat (with country code). Ignored on WhatsApp." },
        },
        required: ["serviceId", "practitionerId", "startAt", "patientName"],
      },
    },
    run: async (raw, ctx) => {
      const args = z
        .object({
          serviceId: uuid,
          practitionerId: uuid,
          startAt: isoDateTime,
          patientName: z.string().trim().min(2).max(100),
          patientPhone: z.string().optional(),
        })
        .parse(raw);
      const phone = ctx.channel === "whatsapp" ? ctx.externalId : args.patientPhone ?? "";
      if (!isPlausiblePhone(phone)) return { error: "A valid phone number (with country code) is required. Ask the patient for it." };

      const start = new Date(args.startAt);
      if (!(await slotIsFree(ctx, args.practitionerId, args.serviceId, start))) {
        return { error: "That time is no longer available. Call get_available_slots again and offer fresh options." };
      }
      try {
        const result = await booking.createAppointment(ctx.config, {
          serviceId: args.serviceId,
          resourceId: args.practitionerId,
          startAt: start,
          patient: { name: args.patientName, phone },
          channel: ctx.channel,
        });
        ctx.session.appointmentIds.push(result.appointmentId);
        const pending = result.status === "PENDING_CONFIRMATION";
        return {
          appointmentId: result.appointmentId,
          reference: result.appointmentId.slice(0, 6),
          status: result.status,
          when: label(start, ctx.config.tenant.timezone),
          meaning: pending
            ? "REQUEST ONLY: the slot is held but the doctor must explicitly accept. Tell the patient they'll be messaged on WhatsApp once the doctor accepts or declines."
            : "CONFIRMED and blocked on the doctor's calendar.",
        };
      } catch (err) {
        if (err instanceof SlotConflictError) return { error: "That time was just taken. Offer fresh options." };
        throw err;
      }
    },
  },
  {
    write: false,
    declaration: {
      name: "verify_booking_reference",
      description:
        "Web chat only: verify who the patient is from the phone number they booked with plus the 6-character booking reference from their confirmation. Needed before listing/cancelling/rescheduling past bookings.",
      parameters: {
        type: "object",
        properties: { phone: { type: "string" }, reference: { type: "string" } },
        required: ["phone", "reference"],
      },
    },
    run: async (raw, ctx) => {
      const args = z.object({ phone: z.string(), reference: z.string().regex(/^[0-9a-fA-F]{6}$/) }).parse(raw);
      if (ctx.channel === "whatsapp") return { verified: true, note: "WhatsApp numbers are already verified." };
      if (ctx.session.verifyAttempts >= 5) return { error: "Too many attempts. Ask the patient to contact the clinic directly." };
      ctx.session.verifyAttempts += 1;
      const result = await pool.query(
        `SELECT p.phone FROM appointments a JOIN patients p ON p.id = a.patient_id
         WHERE a.tenant_id = $1 AND a.id::text LIKE $2 || '%'`,
        [ctx.config.tenant.id, args.reference.toLowerCase()]
      );
      if (result.rows.some((r) => samePhone(r.phone, args.phone))) {
        ctx.session.verifiedPhone = args.phone;
        return { verified: true };
      }
      return { verified: false, note: "No booking matches that phone and reference." };
    },
  },
  {
    write: false,
    declaration: {
      name: "find_my_appointments",
      description: "List the patient's upcoming appointments (pending or confirmed).",
      parameters: { type: "object", properties: {} },
    },
    run: async (_args, ctx) => {
      const phone = identityPhone(ctx);
      if (!phone && ctx.session.appointmentIds.length === 0) return NOT_VERIFIED;
      const result = await pool.query(
        `SELECT a.id, a.status, a.start_at, s.name AS service_name, r.name AS resource_name
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         JOIN services s ON s.id = a.service_id
         JOIN resources r ON r.id = a.resource_id
         WHERE a.tenant_id = $1 AND a.status IN ('PENDING_CONFIRMATION', 'CONFIRMED') AND a.end_at > now()
           AND (right(regexp_replace(p.phone, '\D', '', 'g'), 10) = right($2, 10) OR a.id = ANY($3::uuid[]))
         ORDER BY a.start_at ASC LIMIT 10`,
        [ctx.config.tenant.id, digitsOnly(phone ?? ""), ctx.session.appointmentIds]
      );
      return {
        appointments: result.rows.map((r) => ({
          appointmentId: r.id,
          reference: r.id.slice(0, 6),
          status: r.status,
          service: r.service_name,
          practitioner: r.resource_name,
          when: label(r.start_at, ctx.config.tenant.timezone),
        })),
      };
    },
  },
  {
    write: true,
    declaration: {
      name: "cancel_appointment",
      description: "Cancel one of the patient's appointments. Confirm with the patient first.",
      parameters: {
        type: "object",
        properties: { appointmentId: { type: "string" }, reason: { type: "string" } },
        required: ["appointmentId"],
      },
    },
    run: async (raw, ctx) => {
      const args = z.object({ appointmentId: uuid, reason: z.string().max(300).optional() }).parse(raw);
      if (!(await ownsAppointment(ctx, args.appointmentId))) return identityPhone(ctx) ? { error: "That appointment doesn't belong to this patient." } : NOT_VERIFIED;
      const appt = await booking.cancelAppointment(ctx.config, args.appointmentId, args.reason, "patient");
      return { appointmentId: appt.id, status: appt.status };
    },
  },
  {
    write: true,
    declaration: {
      name: "reschedule_appointment",
      description:
        "Move one of the patient's appointments to a new time (same service and practitioner). newStartAt must be copied exactly from get_available_slots. Confirm with the patient first.",
      parameters: {
        type: "object",
        properties: { appointmentId: { type: "string" }, newStartAt: { type: "string" } },
        required: ["appointmentId", "newStartAt"],
      },
    },
    run: async (raw, ctx) => {
      const args = z.object({ appointmentId: uuid, newStartAt: isoDateTime }).parse(raw);
      if (!(await ownsAppointment(ctx, args.appointmentId))) return identityPhone(ctx) ? { error: "That appointment doesn't belong to this patient." } : NOT_VERIFIED;
      const current = await pool.query("SELECT service_id, resource_id FROM appointments WHERE id = $1 AND tenant_id = $2", [
        args.appointmentId,
        ctx.config.tenant.id,
      ]);
      if (current.rows.length === 0) return { error: "Appointment not found." };
      const start = new Date(args.newStartAt);
      if (!(await slotIsFree(ctx, current.rows[0].resource_id, current.rows[0].service_id, start))) {
        return { error: "That time is not available. Call get_available_slots for the same service and practitioner and offer fresh options." };
      }
      try {
        const appt = await booking.rescheduleAppointment(ctx.config, args.appointmentId, start, "patient");
        return {
          appointmentId: appt.id,
          status: appt.status,
          when: label(start, ctx.config.tenant.timezone),
          meaning:
            appt.status === "PENDING_CONFIRMATION"
              ? "The new time needs the doctor's explicit acceptance again; the patient will be messaged."
              : "Confirmed at the new time.",
        };
      } catch (err) {
        if (err instanceof SlotConflictError) return { error: "That time was just taken. Offer fresh options." };
        throw err;
      }
    },
  },
  {
    write: false,
    declaration: {
      name: "request_human_handoff",
      description:
        "Alert clinic staff that a human should follow up (patient asks for a person, complaint, anything you can't resolve, possible emergency).",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" }, patientName: { type: "string" }, patientPhone: { type: "string" } },
        required: ["reason"],
      },
    },
    run: async (raw, ctx) => {
      const args = z
        .object({ reason: z.string().max(500), patientName: z.string().max(100).optional(), patientPhone: z.string().max(30).optional() })
        .parse(raw);
      const contact = ctx.channel === "whatsapp" ? `+${digitsOnly(ctx.externalId)}` : args.patientPhone ?? "unknown (web chat)";
      const result = await notifyStaff(
        ctx.config.tenant.id,
        `A patient needs a human follow-up.\nName: ${args.patientName ?? "unknown"}\nContact: ${contact}\nChannel: ${ctx.channel}\nReason: ${args.reason}`
      );
      return result === "sent"
        ? { delivered: true }
        : { delivered: false, note: "Staff could not be alerted automatically. Tell the patient to contact the clinic directly." };
    },
  },
];

export const toolDeclarations = tools.map((t) => t.declaration);
const byName = new Map(tools.map((t) => [t.declaration.name, t]));
export const isWriteTool = (name: string): boolean => byName.get(name)?.write ?? false;

/** Never throws: validation and domain errors become `{error}` the model can read and recover from. */
export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const tool = byName.get(name);
  if (!tool) return { error: `Unknown tool: ${name}` };
  try {
    return await tool.run(args, ctx);
  } catch (err) {
    if (err instanceof z.ZodError) return { error: `Invalid arguments: ${err.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
    if (err instanceof AppError) return { error: err.message };
    console.error(`[agent] tool ${name} failed:`, err);
    return { error: "Something went wrong running that action." };
  }
}

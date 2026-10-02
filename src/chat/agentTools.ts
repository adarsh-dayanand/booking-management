import { DateTime } from "luxon";
import { z } from "zod";
import * as booking from "../booking/booking";
import { identityPatient, identityPhone, isoDate, label, NOT_VERIFIED, ownsAppointment, uuid, type AgentSession, type Tool, type ToolContext, type ToolResult } from "./toolKit";
import { paymentTools } from "./paymentTools";
import { freeRanges, resolveIds, resolveWhen, unavailableReply, whenFields, whenParameters, whenTools } from "./whenTools";
import { diagnoseTime } from "../booking/availability";
import { paymentActive, quoteFee, formatRupees } from "../payments/pricing";
import { groupByDay, nearestSpaced, spreadEvenly } from "../booking/slotPicker";
import { pool } from "../lib/db";
import { AppError, SlotConflictError } from "../errors";
import { notifyStaff } from "../channels/notify";
import { sendPhoneOtp, verifyPhoneOtp } from "../channels/phoneOtp";
import { getPatientByPhone, touchPatient, updatePatientDetails } from "../booking/patients";
import { digitsOnly, isPlausiblePhone, normalizePhone } from "../lib/phone";
export type { AgentSession, ToolContext } from "./toolKit";

/** Re-derives availability (hours + bookings + the doctor's live calendar) instead of trusting a model-supplied time. */
async function checkBookable(ctx: ToolContext, resourceId: string, serviceId: string, args: { date?: string; time?: string; startAt?: string }, excludeAppointmentId?: string): Promise<{ start: Date } | { reply: ToolResult }> {
  const when = resolveWhen(ctx, args);
  if ("error" in when) return { reply: when };
  if (!ctx.config.services.some((sv) => sv.id === serviceId)) return { reply: { error: "Unknown service. Call list_services." } };
  if (!ctx.config.resources.some((r) => r.id === resourceId)) return { reply: { error: "Unknown practitioner. Call list_practitioners." } };
  const check = await diagnoseTime(ctx.config, resourceId, serviceId, when.start, new Date(), excludeAppointmentId);
  return check.available ? { start: when.start } : { reply: unavailableReply(ctx, check) };
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
        "Get bookable times, already checked against clinic hours, existing bookings and the doctor's live calendar. `slots` is only a SAMPLE of the free times; `ranges` lists ALL free start times (every `intervalMinutes` within each range). Anything inside a range is free — confirm one specific time with check_time. Dates and times are in the clinic's local timezone.",
      parameters: {
        type: "object",
        properties: {
          serviceId: { type: "string", description: "Service id from list_services" },
          practitionerId: { type: "string", description: "Optional. Omit to search all practitioners." },
          fromDate: { type: "string", description: "YYYY-MM-DD, default today. When the patient names a specific day, set fromDate AND toDate to that day." },
          toDate: { type: "string", description: "YYYY-MM-DD, default two weeks after fromDate (max 21 days). Same as fromDate to look at a single day." },
          partOfDay: { type: "string", enum: ["morning", "afternoon", "evening"] },
          nearTime: { type: "string", description: "HH:MM (24h, clinic time). Return the free times closest to this time of day, e.g. 17:00 when the patient asks for 'around 5pm'." },
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
          nearTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM").optional(),
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
      const pricing = paymentActive(ctx.config.tenant) ? ctx.config.tenant.pricing : null;
      const service = ctx.config.services.find((sv) => sv.id === args.serviceId);
      const found: { practitionerId: string; practitionerName: string; startAt: string; local: string; day: string; fee?: string }[] = [];
      for (const r of practitioners) {
        const slots = await booking.generateAvailableSlots(ctx.config, r.id, args.serviceId, rangeStart, to.toJSDate());
        for (const s of slots) {
          const local = DateTime.fromISO(s.startAt, { zone: "utc" }).setZone(tz);
          if (args.partOfDay && !PART_OF_DAY[args.partOfDay](local.hour)) continue;
          found.push({
            practitionerId: r.id,
            practitionerName: r.name,
            startAt: s.startAt,
            local: local.toFormat("ccc dd LLL yyyy, h:mm a"),
            day: local.toISODate()!,
            ...(pricing && service ? { fee: formatRupees(quoteFee(pricing, tz, new Date(s.startAt), service).amountPaise) } : {}),
          });
        }
      }
      found.sort((a, b) => a.startAt.localeCompare(b.startAt));

      // Times can be offered as often as every 5 minutes, so show a few well-spread (or nearest-to-requested) ones per day.
      const singleDay = from.hasSame(to, "day");
      const cap = singleDay ? 8 : 4;
      const picked = groupByDay(found, tz)
        .flatMap((day) => (args.nearTime ? nearestSpaced(day, tz, args.nearTime, cap, Math.max(15, ctx.config.tenant.slotIntervalMinutes)) : spreadEvenly(day, cap)))
        .slice(0, 12)
        .map(({ day: _day, ...rest }) => rest);
      const searched = { from: from.toISODate(), to: to.toISODate() };
      if (picked.length === 0) {
        // Say WHY a single day is empty, so the patient isn't told a closed day is "booked" (or the reverse).
        const why = from.hasSame(to, "day") && service
          ? practitioners.map((r) => {
              const hours = booking.openingWindowFor(ctx.config, r.id, service, from.set({ hour: 12 }).toJSDate());
              return hours.window ? `${r.name} works ${from.toFormat("cccc d LLL")} but has no free time left then` : `${r.name} isn't working on ${from.toFormat("cccc d LLL")}`;
            }).join("; ")
          : "";
        return { searched, slots: [], note: `${why ? `${why}. ` : ""}No free times ${args.partOfDay ? `in the ${args.partOfDay} ` : ""}between ${searched.from} and ${searched.to}. Say so plainly and offer to search other dates (call get_available_slots again from the next day).` };
      }
      const { slotIntervalMinutes } = ctx.config.tenant;
      return {
        searched,
        slots: picked,
        ranges: freeRanges(found, tz, slotIntervalMinutes).slice(0, 40),
        intervalMinutes: slotIntervalMinutes,
        note: `slots is only a sample. ranges shows every free START time (every ${slotIntervalMinutes} minutes from firstStart to lastStart); lastStart is when the last visit begins, NOT the closing time (call get_opening_hours for that). A time inside a range is free even if it isn't in slots — don't tell the patient it is booked; check it with check_time.`,
      };
    },
  },
  {
    write: true,
    declaration: {
      name: "book_appointment",
      description:
        "Book an appointment for the verified patient. Call ONLY after the patient has explicitly confirmed the service, practitioner, time and the name for the booking. Give the time as `date` + `time` in the clinic's local time (preferred), never converted to UTC. If the time can't be booked you get the exact reason and the nearest free times. The phone number comes from the verified identity — never pass one.",
      parameters: {
        type: "object",
        properties: {
          serviceId: { type: "string", description: "From list_services. Optional when the clinic has only one service." },
          practitionerId: { type: "string", description: "From list_practitioners. Optional when there is only one." },
          ...whenParameters,
          patientName: { type: "string", description: "Name for this booking. Optional if the profile already has the patient's name." },
        },
        required: ["date", "time"],
      },
    },
    run: async (raw, ctx) => {
      const args = z
        .object({
          serviceId: z.string().optional(),
          practitionerId: z.string().optional(),
          ...whenFields,
          patientName: z.string().trim().min(2).max(100).optional(),
        })
        .parse(raw);
      const patient = await identityPatient(ctx);
      if (!patient) return NOT_VERIFIED;
      const name = args.patientName ?? patient.name;
      if (!name) return { error: "Ask the patient for the name to book under." };

      const ids = resolveIds(ctx, args);
      if ("error" in ids) return ids;
      const bookable = await checkBookable(ctx, ids.practitionerId, ids.serviceId, args);
      if (!("start" in bookable)) return bookable.reply;
      const start = bookable.start;
      try {
        const result = await booking.createAppointment(ctx.config, {
          serviceId: ids.serviceId,
          resourceId: ids.practitionerId,
          startAt: start,
          patient: { name, phone: patient.phone },
          phoneVerified: true,
          channel: ctx.channel,
        });
        if (result.payment) {
          if (ctx.outbox) ctx.outbox.payment = result.payment;
          return {
            appointmentId: result.appointmentId,
            reference: result.appointmentId.slice(0, 6),
            status: result.status,
            when: label(start, ctx.config.tenant.timezone),
            amount: result.payment.amount,
            paymentUrl: result.payment.url,
            payBefore: label(result.payment.expiresAt, ctx.config.tenant.timezone),
            meaning:
              "NOT CONFIRMED YET. The time is held for the patient until payBefore. Tell them the amount, give them the paymentUrl, and say the booking is confirmed only after they pay. Do not call it booked or requested.",
          };
        }
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
        if (err instanceof SlotConflictError) return { available: false, reason: "booked", error: "That time was just taken by someone else. Call get_available_slots and offer fresh options." };
        throw err;
      }
    },
  },
  {
    write: false,
    declaration: {
      name: "send_phone_otp",
      description:
        "Web chat only: send a 6-digit verification code to the patient's phone over WhatsApp so they can prove the number is theirs. Needed before booking or managing appointments. Not needed on WhatsApp (the number is already verified).",
      parameters: { type: "object", properties: { phone: { type: "string", description: "With country code if known" } }, required: ["phone"] },
    },
    run: async (raw, ctx) => {
      const args = z.object({ phone: z.string() }).parse(raw);
      if (ctx.channel === "whatsapp") return { verified: true, note: "WhatsApp numbers are already verified." };
      if (!isPlausiblePhone(args.phone)) return { error: "That doesn't look like a valid phone number." };
      ctx.session.claimedPhone = normalizePhone(args.phone);
      await touchPatient(ctx.config.tenant.id, args.phone, { channel: "web" }); // capture the contact right away, unverified
      const result = await sendPhoneOtp(ctx.config.tenant, args.phone);
      if (result.sent) return { sent: true, note: "Code sent over WhatsApp. Ask the patient to type it here." };
      if ("devCode" in result) return { sent: false, devCode: result.devCode, note: `${result.note} Tell the tester the code.` };
      return { error: result.error };
    },
  },
  {
    write: false,
    declaration: {
      name: "verify_phone_otp",
      description: "Web chat only: check the 6-digit code the patient received. On success the chat is bound to that phone number.",
      parameters: { type: "object", properties: { phone: { type: "string" }, code: { type: "string" } }, required: ["phone", "code"] },
    },
    run: async (raw, ctx) => {
      const args = z.object({ phone: z.string(), code: z.string().regex(/^\d{6}$/, "must be 6 digits") }).parse(raw);
      if (ctx.channel === "whatsapp") return { verified: true, note: "WhatsApp numbers are already verified." };
      const result = await verifyPhoneOtp(ctx.config.tenant.id, args.phone, args.code);
      if (!result.verified) return { verified: false, error: result.error };
      ctx.session.verifiedPhone = result.phone;
      const patient = await touchPatient(ctx.config.tenant.id, result.phone, { channel: "web", verified: true });
      return { verified: true, knownName: patient.name, hasEmail: Boolean(patient.email) };
    },
  },
  {
    write: false,
    declaration: {
      name: "get_my_profile",
      description: "The verified patient's saved details (name, email, date of birth, preferred language), so you don't ask for things we already have.",
      parameters: { type: "object", properties: {} },
    },
    run: async (_args, ctx) => {
      const patient = await identityPatient(ctx);
      if (!patient) return NOT_VERIFIED;
      return { name: patient.name, email: patient.email, dateOfBirth: patient.dateOfBirth, preferredLanguage: patient.preferredLanguage };
    },
  },
  {
    write: true,
    declaration: {
      name: "save_patient_details",
      description:
        "Save contact details the patient has volunteered (name, email, date of birth, preferred language). Call this as soon as they share any — no form or registration. Never store medical information.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          email: { type: "string" },
          dateOfBirth: { type: "string", description: "YYYY-MM-DD" },
          preferredLanguage: { type: "string", description: "e.g. English, Hindi, Kannada" },
        },
      },
    },
    run: async (raw, ctx) => {
      const args = z
        .object({
          name: z.string().trim().min(2).max(100).optional(),
          email: z.string().email().max(200).optional(),
          dateOfBirth: isoDate.optional(),
          preferredLanguage: z.string().trim().max(40).optional(),
        })
        .parse(raw);
      if (Object.keys(args).length === 0) return { error: "Nothing to save." };

      let patient = await identityPatient(ctx);
      if (!patient) {
        // Unverified web visitor: remember details against their number only if no verified profile exists for it,
        // so a stranger can't overwrite a real patient's record.
        const claimed = ctx.session.claimedPhone;
        if (!claimed) return NOT_VERIFIED;
        const existing = await getPatientByPhone(ctx.config.tenant.id, claimed);
        if (existing?.phoneVerified) return NOT_VERIFIED;
        patient = await touchPatient(ctx.config.tenant.id, claimed, { channel: "web" });
      }
      const saved = await updatePatientDetails(ctx.config.tenant.id, patient.id, args);
      return { saved: Object.keys(args), profile: { name: saved.name, email: saved.email } };
    },
  },
  {
    write: false,
    declaration: {
      name: "find_my_appointments",
      description: "List the patient's upcoming appointments (awaiting payment, pending or confirmed).",
      parameters: { type: "object", properties: {} },
    },
    run: async (_args, ctx) => {
      const phone = identityPhone(ctx);
      if (!phone) return NOT_VERIFIED;
      const result = await pool.query(
        `SELECT a.id, a.status, a.start_at, s.name AS service_name, r.name AS resource_name, pay.razorpay_payment_link_url AS payment_url
         FROM appointments a
         JOIN patients p ON p.id = a.patient_id
         JOIN services s ON s.id = a.service_id
         JOIN resources r ON r.id = a.resource_id
         LEFT JOIN payments pay ON pay.appointment_id = a.id AND pay.status = 'created'
         WHERE a.tenant_id = $1 AND p.phone_normalized = $2
           AND a.status IN ('AWAITING_PAYMENT', 'PENDING_CONFIRMATION', 'CONFIRMED') AND a.end_at > now()
         ORDER BY a.start_at ASC LIMIT 10`,
        [ctx.config.tenant.id, phone]
      );
      return {
        appointments: result.rows.map((r) => ({
          appointmentId: r.id,
          reference: r.id.slice(0, 6),
          status: r.status,
          service: r.service_name,
          practitioner: r.resource_name,
          when: label(r.start_at, ctx.config.tenant.timezone),
          ...(r.status === "AWAITING_PAYMENT" ? { paymentUrl: r.payment_url, note: "Unpaid: held until paid, not confirmed." } : {}),
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
        "Move one of the patient's appointments to a new time (same service and practitioner). Give the new time as `date` + `time` in the clinic's local time. If it can't be booked you get the reason and the nearest free times. Confirm with the patient first.",
      parameters: {
        type: "object",
        properties: { appointmentId: { type: "string" }, ...whenParameters },
        required: ["appointmentId"],
      },
    },
    run: async (raw, ctx) => {
      const args = z.object({ appointmentId: uuid, ...whenFields }).parse(raw);
      if (!(await ownsAppointment(ctx, args.appointmentId))) return identityPhone(ctx) ? { error: "That appointment doesn't belong to this patient." } : NOT_VERIFIED;
      const current = await pool.query("SELECT service_id, resource_id FROM appointments WHERE id = $1 AND tenant_id = $2", [
        args.appointmentId,
        ctx.config.tenant.id,
      ]);
      if (current.rows.length === 0) return { error: "Appointment not found." };
      const bookable = await checkBookable(ctx, current.rows[0].resource_id, current.rows[0].service_id, args, args.appointmentId);
      if (!("start" in bookable)) return bookable.reply;
      const start = bookable.start;
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
        if (err instanceof SlotConflictError) return { available: false, reason: "booked", error: "That time was just taken by someone else. Call get_available_slots and offer fresh options." };
        throw err;
      }
    },
  },
  {
    write: false,
    declaration: {
      name: "request_human_handoff",
      description:
        "Alert the clinic's team that a human should follow up (patient asks for a person, complaint, anything you can't resolve, possible emergency).",
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
      const contact = ctx.channel === "whatsapp" ? `+${digitsOnly(ctx.externalId)}` : args.patientPhone ?? (ctx.session.claimedPhone ? `+${ctx.session.claimedPhone} (unverified)` : "unknown (web chat)");
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

tools.push(...whenTools, ...paymentTools);

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

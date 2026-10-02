import { randomUUID } from "crypto";
import { DateTime } from "luxon";
import { pool, EXCLUSION_VIOLATION, isPgError } from "../lib/db";
import { NotFoundError, SlotConflictError, StaleVersionError, ValidationError } from "../errors";
import * as googleCalendar from "../calendar/googleCalendar";
import { notifyAppointmentEvent, type Actor } from "../channels/notify";
import { touchPatient } from "./patients";
import { config as appConfig } from "../config";
import { paymentActive, quoteFee } from "../payments/pricing";
import { openPaymentLink, voidUnpaidPayment } from "../payments/checkout";
import * as payments from "../payments/store";
import { toOffer, type PaymentOffer } from "../payments/offer";
import { loadTenantConfigById } from "./tenant";
import type {
  Appointment,
  AppointmentStatus,
  Channel,
  Resource,
  Service,
  Slot,
  TenantConfig,
} from "../types";

export const DEFAULT_MIN_NOTICE_MINUTES = 30;

function findService(config: TenantConfig, serviceId: string): Service {
  const service = config.services.find((s) => s.id === serviceId && s.active);
  if (!service) throw new NotFoundError("Unknown or inactive service");
  return service;
}

function findResource(config: TenantConfig, resourceId: string): Resource {
  const resource = config.resources.find((r) => r.id === resourceId && r.active);
  if (!resource) throw new NotFoundError("Unknown or inactive resource");
  return resource;
}

// ---------------------------------------------------------------------------
// Slot generation
// ---------------------------------------------------------------------------

export interface GenerateSlotsOptions {
  minNoticeMinutes?: number;
  slotGranularityMinutes?: number;
  now?: Date;
  /** Moving an appointment: it must not block its own new time. */
  excludeAppointmentId?: string;
}

/** Start times for a service follow from the service itself: back to back, each visit plus its own turnover buffer. */
export const slotStepMinutes = (service: Service): number => service.durationMinutes + service.bufferMinutes;

/**
 * Pure candidate-slot generator: hours + service duration only, no DB or
 * calendar lookups. Kept separate so timezone/hours logic is unit-testable
 * without a database.
 */
export function computeCandidateSlots(
  config: TenantConfig,
  resourceId: string,
  service: Service,
  rangeStart: Date,
  rangeEnd: Date,
  options: GenerateSlotsOptions = {}
): Slot[] {
  const tz = config.tenant.timezone;
  const now = options.now ?? new Date();
  const minNotice = options.minNoticeMinutes ?? DEFAULT_MIN_NOTICE_MINUTES;
  const granularity = options.slotGranularityMinutes ?? slotStepMinutes(service);
  const earliestAllowed = DateTime.fromJSDate(now, { zone: tz }).plus({ minutes: minNotice });

  const rules = config.availabilityRules.filter((r) => r.resourceId === resourceId);
  const slots: Slot[] = [];

  let day = DateTime.fromJSDate(rangeStart, { zone: tz }).startOf("day");
  const end = DateTime.fromJSDate(rangeEnd, { zone: tz });

  while (day <= end) {
    const isoDate = day.toISODate();
    const exceptionRule = rules.find((r) => r.specificDate === isoDate);
    const weeklyRule = rules.find((r) => r.weekday === day.weekday % 7);
    const rule = exceptionRule ?? weeklyRule;

    if (rule && !rule.isClosed && rule.startTime && rule.endTime) {
      const [openH, openM] = rule.startTime.split(":").map(Number);
      const [closeH, closeM] = rule.endTime.split(":").map(Number);
      let candidate = day.set({ hour: openH, minute: openM, second: 0, millisecond: 0 });
      const close = day.set({ hour: closeH, minute: closeM, second: 0, millisecond: 0 });

      while (candidate.plus({ minutes: service.durationMinutes }) <= close) {
        const candidateUtc = candidate.toUTC().toJSDate();
        if (candidateUtc >= rangeStart && candidateUtc <= rangeEnd && candidate >= earliestAllowed) {
          slots.push({
            startAt: candidate.toUTC().toISO()!,
            endAt: candidate.plus({ minutes: service.durationMinutes }).toUTC().toISO()!,
          });
        }
        candidate = candidate.plus({ minutes: granularity });
      }
    }

    day = day.plus({ days: 1 });
  }

  return slots;
}

/**
 * Whether a visit starting at `start` sits inside the practitioner's opening hours for that local day (a date
 * exception beats the weekly rule). Used to warn a consultant who deliberately books outside hours; never blocks.
 */
export function openingWindowFor(
  config: TenantConfig,
  resourceId: string,
  service: Service,
  start: Date
): { within: boolean; window: { start: string; end: string } | null } {
  const rule = ruleOn(config, resourceId, DateTime.fromJSDate(start, { zone: config.tenant.timezone }));
  const local = DateTime.fromJSDate(start, { zone: config.tenant.timezone });
  if (!rule) return { within: false, window: null };
  const minutes = (hhmmss: string) => Number(hhmmss.slice(0, 2)) * 60 + Number(hhmmss.slice(3, 5));
  const startMin = local.hour * 60 + local.minute;
  const endMin = startMin + service.durationMinutes;
  return {
    within: startMin >= minutes(rule.startTime!) && endMin <= minutes(rule.endTime!),
    window: { start: rule.startTime!.slice(0, 5), end: rule.endTime!.slice(0, 5) },
  };
}

/** The opening rule in force for a local day: a date exception beats the weekly rule; null when closed or unset. */
function ruleOn(config: TenantConfig, resourceId: string, local: DateTime) {
  const rules = config.availabilityRules.filter((r) => r.resourceId === resourceId);
  const rule = rules.find((r) => r.specificDate === local.toISODate()) ?? rules.find((r) => r.weekday === local.weekday % 7);
  return rule && !rule.isClosed && rule.startTime && rule.endTime ? rule : null;
}

/**
 * Whether `start` is one of the start times offered for `service` that day: opening time plus a whole number of the
 * service's own steps (duration + buffer). Offers are anchored at opening time, so a 09:15 opening with a 30-minute
 * step gives 09:15, 09:45…
 */
export function onSlotGrid(config: TenantConfig, resourceId: string, service: Service, start: Date): boolean {
  const local = DateTime.fromJSDate(start, { zone: config.tenant.timezone });
  const rule = ruleOn(config, resourceId, local);
  if (!rule) return true; // no opening hours that day, so there is no grid to be off
  const open = Number(rule.startTime!.slice(0, 2)) * 60 + Number(rule.startTime!.slice(3, 5));
  return (local.hour * 60 + local.minute - open) % slotStepMinutes(service) === 0;
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Full availability: candidate slots minus existing app bookings minus (best
 * effort) Google Calendar busy time. Never throws on a Calendar API failure —
 * falls back to DB-only availability so a Calendar outage never blocks booking.
 */
export async function generateAvailableSlots(
  config: TenantConfig,
  resourceId: string,
  serviceId: string,
  rangeStart: Date,
  rangeEnd: Date,
  options: GenerateSlotsOptions = {}
): Promise<Slot[]> {
  const service = findService(config, serviceId);
  const resource = findResource(config, resourceId);
  const candidates = computeCandidateSlots(config, resourceId, service, rangeStart, rangeEnd, options);
  if (candidates.length === 0) return candidates;

  // A candidate near the end of the range reaches `footprint` minutes past it, so look for busy time that far out too —
  // otherwise a booking starting just after the window would be missed and its neighbour wrongly offered.
  const footprintMinutes = service.durationMinutes + service.bufferMinutes;
  const busyEnd = new Date(rangeEnd.getTime() + footprintMinutes * 60_000);

  // Every visit reserves its own length PLUS ITS OWN service's buffer (turnover time). Without this a visit's buffer would
  // protect only the time before the next booking, never the time after it — and with mixed services a 15-minute visit
  // could be offered at the very minute a 45-minute visit with a 15-minute buffer ends.
  const existing = await pool.query(
    `SELECT a.start_at, a.end_at + make_interval(mins => s.buffer_minutes) AS busy_end
     FROM appointments a JOIN services s ON s.id = a.service_id
     WHERE a.tenant_id = $1 AND a.resource_id = $2 AND a.status IN ('AWAITING_PAYMENT', 'PENDING_CONFIRMATION', 'CONFIRMED')
       AND a.start_at < $4 AND a.end_at + make_interval(mins => s.buffer_minutes) > $3
       AND ($5::uuid IS NULL OR a.id <> $5)`,
    [config.tenant.id, resourceId, rangeStart, busyEnd, options.excludeAppointmentId ?? null]
  );
  const busyIntervals = existing.rows.map((r) => ({ start: new Date(r.start_at), end: new Date(r.busy_end) }));

  if (resource.googleConnectionStatus === "connected") {
    try {
      const calendarBusy = await googleCalendar.freeBusyQuery(resource, rangeStart, busyEnd);
      busyIntervals.push(...calendarBusy);
    } catch (err) {
      console.warn(`[booking] Google freebusy check failed for resource ${resource.id}, falling back to DB-only availability:`, err);
    }
  }

  return candidates.filter((slot) => {
    const start = new Date(slot.startAt);
    const footprintEnd = new Date(start.getTime() + footprintMinutes * 60_000);
    return !busyIntervals.some((busy) => overlaps(start, footprintEnd, busy.start, busy.end));
  });
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type AppointmentAction = "APPROVE" | "REJECT" | "CANCEL" | "RESCHEDULE";

const TRANSITIONS: Record<AppointmentAction, { from: AppointmentStatus[]; to: AppointmentStatus }> = {
  APPROVE: { from: ["PENDING_CONFIRMATION"], to: "CONFIRMED" },
  REJECT: { from: ["PENDING_CONFIRMATION"], to: "REJECTED" },
  CANCEL: { from: ["AWAITING_PAYMENT", "PENDING_CONFIRMATION", "CONFIRMED"], to: "CANCELLED" },
  RESCHEDULE: { from: ["PENDING_CONFIRMATION", "CONFIRMED"], to: "PENDING_CONFIRMATION" },
};

export function canTransition(current: AppointmentStatus, action: AppointmentAction): boolean {
  return TRANSITIONS[action].from.includes(current);
}

// ---------------------------------------------------------------------------
// Booking creation
// ---------------------------------------------------------------------------

export interface CreateAppointmentInput {
  serviceId: string;
  resourceId: string;
  startAt: Date;
  patient: { name: string; phone: string; email?: string };
  /** The phone is proven (WhatsApp sender or completed OTP), as opposed to merely typed in. */
  phoneVerified?: boolean;
  channel: Channel;
  idempotencyKey?: string;
}

export interface CreateAppointmentResult {
  appointmentId: string;
  status: AppointmentStatus;
  /** Present when the clinic collects payment: the booking stays AWAITING_PAYMENT until this is paid. */
  payment?: PaymentOffer;
}

export function mapAppointment(row: any): Appointment {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    patientId: row.patient_id,
    serviceId: row.service_id,
    resourceId: row.resource_id,
    startAt: row.start_at,
    endAt: row.end_at,
    status: row.status,
    channel: row.channel,
    idempotencyKey: row.idempotency_key,
    googleEventId: row.google_event_id,
    calendarSyncStatus: row.calendar_sync_status,
    version: row.version,
  };
}

export async function createAppointment(
  config: TenantConfig,
  input: CreateAppointmentInput
): Promise<CreateAppointmentResult> {
  const service = findService(config, input.serviceId);
  const resource = findResource(config, input.resourceId);
  if (!input.patient.name?.trim() || !input.patient.phone?.trim()) {
    throw new ValidationError("Patient name and phone are required");
  }

  const idempotencyKey = input.idempotencyKey ?? randomUUID();
  const endAt = new Date(input.startAt.getTime() + service.durationMinutes * 60_000);

  // Payment first, confirmation second: when the clinic collects fees the slot is only HELD (AWAITING_PAYMENT)
  // until the patient pays; the policy-based status (CONFIRMED / PENDING_CONFIRMATION) applies after that.
  const quote = paymentActive(config.tenant) ? quoteFee(config.tenant.pricing!, config.tenant.timezone, input.startAt, service) : null;
  const needsPayment = quote !== null && quote.amountPaise > 0;
  const credentials = needsPayment ? await payments.loadCredentials(config.tenant.id) : null;
  if (needsPayment && !credentials) throw new ValidationError("Online payment isn't set up for this clinic yet");
  const holdExpiresAt = new Date(Date.now() + appConfig.payments.holdMinutes * 60_000);

  const targetStatus: AppointmentStatus = needsPayment
    ? "AWAITING_PAYMENT"
    : config.tenant.confirmationPolicy === "instant" ? "CONFIRMED" : "PENDING_CONFIRMATION";

  const client = await pool.connect();
  let appointment: Appointment;
  let patientRow: { name: string; phone: string };
  try {
    await client.query("BEGIN");

    const existing = await client.query(
      "SELECT * FROM appointments WHERE tenant_id = $1 AND idempotency_key = $2",
      [config.tenant.id, idempotencyKey]
    );
    if (existing.rowCount && existing.rowCount > 0) {
      await client.query("COMMIT");
      const row = existing.rows[0];
      const pending = row.status === "AWAITING_PAYMENT" ? await payments.getByAppointment(config.tenant.id, row.id) : null;
      return { appointmentId: row.id, status: row.status, ...(pending?.linkUrl ? { payment: toOffer(pending) } : {}) };
    }

    // No registration step: the patient profile is keyed by phone number and reused across bookings.
    const patient = await touchPatient(
      config.tenant.id,
      input.patient.phone,
      { channel: input.channel, name: input.patient.name, nameSource: "patient", verified: input.phoneVerified },
      client
    );
    patientRow = { name: input.patient.name.trim(), phone: patient.phone };
    if (input.patient.email) {
      await client.query("UPDATE patients SET email = COALESCE(email, $2) WHERE id = $1", [patient.id, input.patient.email]);
    }

    const appointmentResult = await client.query(
      `INSERT INTO appointments
         (tenant_id, patient_id, patient_name, service_id, resource_id, start_at, end_at, status, channel, idempotency_key)
       VALUES ($1, $2, $10, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        config.tenant.id,
        patient.id,
        service.id,
        resource.id,
        input.startAt,
        endAt,
        targetStatus,
        input.channel,
        idempotencyKey,
        input.patient.name.trim(),
      ]
    );
    appointment = mapAppointment(appointmentResult.rows[0]);

    if (needsPayment) {
      await payments.insertPayment(client, {
        tenantId: config.tenant.id,
        appointmentId: appointment.id,
        amountPaise: quote!.amountPaise,
        band: quote!.band,
        expiresAt: holdExpiresAt,
      });
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    if (isPgError(err, EXCLUSION_VIOLATION)) throw new SlotConflictError();
    throw err;
  } finally {
    client.release();
  }

  if (needsPayment) {
    // Nothing is calendar-synced or sent to the doctor yet: that happens when the payment lands (payments/settlement.ts).
    const payment = await openPaymentLink(credentials!, {
      appointmentId: appointment.id,
      amountPaise: quote!.amountPaise,
      description: `${service.name} with ${resource.name} at ${config.tenant.name}`,
      expiresAt: holdExpiresAt,
      patient: patientRow!,
    });
    return { appointmentId: appointment.id, status: "AWAITING_PAYMENT", payment };
  }

  await syncToCalendar(resource, appointment, "create");
  await notifyAppointmentEvent(appointment.id, "created", "patient");
  return { appointmentId: appointment.id, status: appointment.status };
}

// ---------------------------------------------------------------------------
// Staff actions: approve / reject / cancel / reschedule
// ---------------------------------------------------------------------------

async function loadAppointment(tenantId: string, appointmentId: string): Promise<Appointment> {
  const result = await pool.query("SELECT * FROM appointments WHERE id = $1 AND tenant_id = $2", [
    appointmentId,
    tenantId,
  ]);
  if (result.rowCount === 0) throw new NotFoundError("Appointment not found");
  return mapAppointment(result.rows[0]);
}

async function transition(
  config: TenantConfig,
  appointmentId: string,
  action: AppointmentAction,
  reasonColumn?: "cancel_reason" | "rejected_reason",
  reason?: string
): Promise<Appointment> {
  const current = await loadAppointment(config.tenant.id, appointmentId);
  if (!canTransition(current.status, action)) {
    throw new ValidationError(`Cannot ${action} an appointment in status ${current.status}`);
  }
  const newStatus = TRANSITIONS[action].to;

  const extraSet = reasonColumn ? `, ${reasonColumn} = $4` : "";
  const params = reasonColumn ? [newStatus, appointmentId, current.version, reason ?? null] : [newStatus, appointmentId, current.version];

  const result = await pool.query(
    `UPDATE appointments SET status = $1, version = version + 1, updated_at = now() ${extraSet}
     WHERE id = $2 AND version = $3 RETURNING *`,
    params
  );
  if (result.rowCount === 0) throw new StaleVersionError();
  return mapAppointment(result.rows[0]);
}

/** Doctor explicitly accepts: the tentative calendar hold becomes a confirmed event. */
export async function approveAppointment(
  config: TenantConfig,
  appointmentId: string,
  actor: Actor = "staff"
): Promise<Appointment> {
  const appointment = await transition(config, appointmentId, "APPROVE");
  await syncToCalendar(findResource(config, appointment.resourceId), appointment, "update");
  await notifyAppointmentEvent(appointment.id, "approved", actor);
  return appointment;
}

export async function rejectAppointment(
  config: TenantConfig,
  appointmentId: string,
  reason?: string,
  actor: Actor = "staff"
): Promise<Appointment> {
  const appointment = await transition(config, appointmentId, "REJECT", "rejected_reason", reason);
  await syncToCalendar(findResource(config, appointment.resourceId), appointment, "cancel"); // drop the tentative hold
  await notifyAppointmentEvent(appointment.id, "rejected", actor);
  return appointment;
}

export async function cancelAppointment(
  config: TenantConfig,
  appointmentId: string,
  reason?: string,
  actor: Actor = "staff"
): Promise<Appointment> {
  const appointment = await transition(config, appointmentId, "CANCEL", "cancel_reason", reason);
  const resource = findResource(config, appointment.resourceId);
  await syncToCalendar(resource, appointment, "cancel");
  await voidUnpaidPayment(config.tenant.id, appointment.id);
  await notifyAppointmentEvent(appointment.id, "cancelled", actor);
  return appointment;
}

export async function rescheduleAppointment(
  config: TenantConfig,
  appointmentId: string,
  newStartAt: Date,
  actor: Actor = "staff"
): Promise<Appointment> {
  const current = await loadAppointment(config.tenant.id, appointmentId);
  if (!canTransition(current.status, "RESCHEDULE")) {
    throw new ValidationError(`Cannot reschedule an appointment in status ${current.status}`);
  }
  const service = findService(config, current.serviceId);
  const newEndAt = new Date(newStartAt.getTime() + service.durationMinutes * 60_000);
  const targetStatus: AppointmentStatus =
    config.tenant.confirmationPolicy === "instant" ? "CONFIRMED" : "PENDING_CONFIRMATION";

  let appointment: Appointment;
  try {
    const result = await pool.query(
      `UPDATE appointments SET start_at = $1, end_at = $2, status = $3, version = version + 1, updated_at = now(), reminder_sent_at = NULL
       WHERE id = $4 AND version = $5 RETURNING *`,
      [newStartAt, newEndAt, targetStatus, appointmentId, current.version]
    );
    if (result.rowCount === 0) throw new StaleVersionError();
    appointment = mapAppointment(result.rows[0]);
  } catch (err) {
    if (isPgError(err, EXCLUSION_VIOLATION)) throw new SlotConflictError();
    throw err;
  }

  const resource = findResource(config, appointment.resourceId);
  await syncToCalendar(resource, appointment, "update");
  await notifyAppointmentEvent(appointment.id, "rescheduled", actor);
  return appointment;
}

/** The doctor moved the event in their own calendar: the calendar is the source of truth, so mirror it. */
export async function applyExternalReschedule(
  config: TenantConfig,
  appointmentId: string,
  newStartAt: Date,
  newEndAt: Date
): Promise<Appointment> {
  const current = await loadAppointment(config.tenant.id, appointmentId);
  if (!canTransition(current.status, "RESCHEDULE")) {
    throw new ValidationError(`Cannot move an appointment in status ${current.status}`);
  }
  let appointment: Appointment;
  try {
    const result = await pool.query(
      `UPDATE appointments SET start_at = $1, end_at = $2, version = version + 1, updated_at = now(), reminder_sent_at = NULL
       WHERE id = $3 AND version = $4 RETURNING *`,
      [newStartAt, newEndAt, appointmentId, current.version]
    );
    if (result.rowCount === 0) throw new StaleVersionError();
    appointment = mapAppointment(result.rows[0]);
  } catch (err) {
    if (isPgError(err, EXCLUSION_VIOLATION)) throw new SlotConflictError();
    throw err;
  }
  await notifyAppointmentEvent(appointment.id, "rescheduled", "calendar");
  return appointment;
}

export async function retrySync(config: TenantConfig, appointmentId: string): Promise<Appointment> {
  const appointment = await loadAppointment(config.tenant.id, appointmentId);
  const resource = findResource(config, appointment.resourceId);
  await syncToCalendar(resource, appointment, appointment.googleEventId ? "update" : "create");
  return loadAppointment(config.tenant.id, appointmentId);
}

/** Background retry for appointments whose calendar sync failed earlier. Returns how many were attempted. */
export async function retryFailedSyncs(limit = 25): Promise<number> {
  const failed = await pool.query(
    `SELECT * FROM appointments
     WHERE calendar_sync_status = 'failed' AND (status IN ('PENDING_CONFIRMATION', 'CONFIRMED') AND end_at > now() OR status IN ('CANCELLED', 'REJECTED'))
     ORDER BY updated_at ASC LIMIT $1`,
    [limit]
  );
  for (const row of failed.rows) {
    const appointment = mapAppointment(row);
    try {
      const config = await loadTenantConfigById(appointment.tenantId);
      const resource = findResource(config, appointment.resourceId);
      const closed = appointment.status === "CANCELLED" || appointment.status === "REJECTED";
      await syncToCalendar(resource, appointment, closed ? "cancel" : appointment.googleEventId ? "update" : "create");
    } catch (err) {
      console.warn(`[booking] background sync retry failed for ${appointment.id}:`, err);
    }
  }
  return failed.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Calendar sync (fail-soft: never throws, always records the outcome)
// ---------------------------------------------------------------------------

export async function syncToCalendar(
  resource: Resource,
  appointment: Appointment,
  action: "create" | "update" | "cancel"
): Promise<void> {
  if (resource.googleConnectionStatus !== "connected") {
    await pool.query("UPDATE appointments SET calendar_sync_status = 'skipped' WHERE id = $1", [appointment.id]);
    return;
  }

  try {
    if (action === "cancel") {
      if (appointment.googleEventId) await googleCalendar.deleteEvent(resource, appointment.googleEventId);
      await pool.query("UPDATE appointments SET calendar_sync_status = 'synced' WHERE id = $1", [appointment.id]);
      return;
    }

    if (action === "create" || !appointment.googleEventId) {
      const eventId = await googleCalendar.createEvent(resource, appointment);
      await pool.query(
        "UPDATE appointments SET google_event_id = $1, calendar_sync_status = 'synced' WHERE id = $2",
        [eventId, appointment.id]
      );
    } else {
      await googleCalendar.updateEvent(resource, appointment.googleEventId, appointment);
      await pool.query("UPDATE appointments SET calendar_sync_status = 'synced' WHERE id = $1", [appointment.id]);
    }
  } catch (err) {
    console.warn(`[booking] Calendar sync failed for appointment ${appointment.id}:`, err);
    await pool.query("UPDATE appointments SET calendar_sync_status = 'failed' WHERE id = $1", [appointment.id]);
  }
}

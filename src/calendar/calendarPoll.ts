import * as booking from "../booking/booking";
import { pool } from "../lib/db";
import { SlotConflictError } from "../errors";
import * as googleCalendar from "./googleCalendar";
import { notifyStaff } from "../channels/notify";
import { loadTenantConfigById, mapResource } from "../booking/tenant";
import type { TenantConfig } from "../types";

const MOVE_TOLERANCE_MS = 60_000;

/**
 * Mirrors the doctor's own edits back into the app: deleting a booked event cancels the appointment,
 * dragging it to another time moves the appointment, and patients are told either way. Polling (rather
 * than Google push channels) keeps this working without a public HTTPS endpoint per calendar.
 */
export async function pollCalendarChanges(): Promise<void> {
  const resources = await pool.query(
    "SELECT * FROM resources WHERE google_connection_status = 'connected' AND active = true"
  );
  const configs = new Map<string, TenantConfig>();

  for (const row of resources.rows) {
    const resource = mapResource(row);
    const startedAt = new Date();
    const since: Date = row.calendar_synced_at ? new Date(row.calendar_synced_at) : new Date(startedAt.getTime() - 10 * 60_000);
    try {
      if (!configs.has(resource.tenantId)) configs.set(resource.tenantId, await loadTenantConfigById(resource.tenantId));
      const config = configs.get(resource.tenantId)!;

      for (const event of await googleCalendar.listChangedEvents(resource, since)) {
        const found = await pool.query(
          `SELECT id, start_at, end_at FROM appointments
           WHERE resource_id = $1 AND google_event_id = $2 AND status IN ('PENDING_CONFIRMATION', 'CONFIRMED')`,
          [resource.id, event.id]
        );
        const appointment = found.rows[0];
        if (!appointment) continue; // not ours, or already closed (including our own deletes)

        try {
          if (event.cancelled) {
            await booking.cancelAppointment(config, appointment.id, "Removed from the doctor's calendar", "calendar");
          } else if (event.start && event.end) {
            const moved =
              Math.abs(event.start.getTime() - new Date(appointment.start_at).getTime()) > MOVE_TOLERANCE_MS ||
              Math.abs(event.end.getTime() - new Date(appointment.end_at).getTime()) > MOVE_TOLERANCE_MS;
            if (moved) await booking.applyExternalReschedule(config, appointment.id, event.start, event.end);
          }
        } catch (err) {
          if (err instanceof SlotConflictError) {
            await notifyStaff(
              resource.tenantId,
              `You moved a booking on ${resource.name}'s calendar onto a time that's already taken in the system, so I left the appointment (ref ${appointment.id.slice(0, 6)}) unchanged. Please fix it in the calendar or reply CANCEL ${appointment.id.slice(0, 6)}.`
            );
          } else {
            console.warn(`[calendarPoll] could not apply change for appointment ${appointment.id}:`, err);
          }
        }
      }
      await pool.query("UPDATE resources SET calendar_synced_at = $1 WHERE id = $2", [startedAt, resource.id]);
    } catch (err) {
      if (googleCalendar.isAuthRevoked(err)) {
        await pool.query("UPDATE resources SET google_connection_status = 'error' WHERE id = $1", [resource.id]);
        await notifyStaff(
          resource.tenantId,
          `Google Calendar access for ${resource.name} was revoked or expired, so availability can't be checked. Reply CONNECT to reconnect.`
        );
      } else {
        console.warn(`[calendarPoll] failed for resource ${resource.id}:`, err);
      }
    }
  }
}

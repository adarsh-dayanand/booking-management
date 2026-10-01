import * as booking from "../booking/booking";
import { pollCalendarChanges } from "../calendar/calendarPoll";
import { config } from "../config";
import { pool } from "../lib/db";
import { notifyAppointmentEvent } from "../channels/notify";

let running = false;

/** Sends due reminders. The UPDATE ... RETURNING claims each appointment atomically, so overlapping runs can't double-send. */
export async function sendDueReminders(): Promise<number> {
  const claimed = await pool.query(
    `UPDATE appointments a SET reminder_sent_at = now()
     FROM tenants t
     WHERE a.tenant_id = t.id AND a.status = 'CONFIRMED' AND a.reminder_sent_at IS NULL
       AND t.reminder_hours_before > 0
       AND a.start_at > now() + interval '2 hours'                       -- no last-minute reminders
       AND a.start_at <= now() + make_interval(hours => t.reminder_hours_before)
       AND a.updated_at <= now() - interval '1 hour'                      -- not right after booking/changing it
     RETURNING a.id`
  );
  for (const row of claimed.rows) {
    const result = await notifyAppointmentEvent(row.id, "reminder", "system");
    // A real send failure releases the claim so the next run retries; "skipped" (e.g. WhatsApp unset) does not.
    if (result === "failed") await pool.query("UPDATE appointments SET reminder_sent_at = NULL WHERE id = $1", [row.id]);
  }
  return claimed.rowCount ?? 0;
}

export async function runSchedulerOnce(): Promise<void> {
  const steps: [string, () => Promise<unknown>][] = [
    ["calendar poll", pollCalendarChanges],
    ["calendar sync retry", () => booking.retryFailedSyncs()],
    ["reminders", sendDueReminders],
    ["dedupe cleanup", () => pool.query("DELETE FROM processed_messages WHERE created_at < now() - interval '7 days'")],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (err) {
      console.error(`[scheduler] ${name} failed:`, err);
    }
  }
}

/** In-process background loop (no separate worker for the POC). Disable with DISABLE_SCHEDULER=1. */
export function startScheduler(): void {
  if (!config.schedulerEnabled) return;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runSchedulerOnce();
    } finally {
      running = false;
    }
  }, config.schedulerIntervalMs);
  timer.unref();
  console.log(`Scheduler running every ${Math.round(config.schedulerIntervalMs / 1000)}s (calendar sync, reminders)`);
}

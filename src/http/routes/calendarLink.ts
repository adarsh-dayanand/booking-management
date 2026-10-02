import { Router } from "express";
import { pool } from "../../lib/db";
import { NotFoundError } from "../../errors";
import { buildIcs, verifyCalendarToken } from "../../calendar/addToCalendar";

export const calendarLinkRouter = Router();

/** The .ics behind an "add to calendar" link. Public, but only reachable with the signed token we put in the message. */
calendarLinkRouter.get("/:token.ics", async (req, res, next) => {
  try {
    const id = verifyCalendarToken(req.params.token);
    if (!id) throw new NotFoundError("Calendar link not found");
    const row = (await pool.query(
      `SELECT a.id, a.version, a.start_at, a.end_at, a.status, s.name AS service_name, r.name AS resource_name, t.name AS clinic_name
       FROM appointments a JOIN services s ON s.id = a.service_id JOIN resources r ON r.id = a.resource_id JOIN tenants t ON t.id = a.tenant_id
       WHERE a.id = $1`,
      [id]
    )).rows[0];
    if (!row) throw new NotFoundError("Calendar link not found");
    if (["CANCELLED", "REJECTED"].includes(row.status)) {
      res.status(410).type("text/plain").send("This appointment is no longer active.");
      return;
    }
    const ics = buildIcs({
      appointmentId: row.id,
      version: row.version,
      startAt: new Date(row.start_at),
      endAt: new Date(row.end_at),
      status: row.status,
      title: `${row.service_name} with ${row.resource_name}`,
      clinicName: row.clinic_name,
      details: `Appointment at ${row.clinic_name}. Ref: ${row.id.slice(0, 6)}`, // deliberately no phone number or notes: the link gets forwarded
    });
    res.set({ "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'inline; filename="appointment.ics"', "Cache-Control": "no-store" }).send(ics);
  } catch (err) {
    next(err);
  }
});

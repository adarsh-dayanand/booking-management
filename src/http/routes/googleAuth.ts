import { Router } from "express";
import { requireAuth, verifyPurposeToken } from "../auth";
import { pool } from "../../lib/db";
import { NotFoundError, ValidationError } from "../../errors";
import * as googleCalendar from "../../calendar/googleCalendar";
import { notifyStaff } from "../../channels/notify";

export const googleAuthRouter = Router();

// Staff-initiated from the dashboard/API: GET /auth/google/connect?resourceId=... (requires login).
googleAuthRouter.get("/connect", requireAuth, async (req, res, next) => {
  try {
    const resourceId = String(req.query.resourceId || "");
    if (!resourceId) throw new ValidationError("resourceId query parameter is required");

    const result = await pool.query("SELECT id FROM resources WHERE id = $1 AND tenant_id = $2", [
      resourceId,
      req.consultant!.tenantId,
    ]);
    if (result.rowCount === 0) throw new NotFoundError("Resource not found");

    res.redirect(googleCalendar.getAuthUrl(resourceId));
  } catch (err) {
    next(err);
  }
});

// Self-serve: the doctor opens a short-lived signed link (sent via the WhatsApp CONNECT command or the
// admin API) — no login needed, but the link only works for the one resource it was signed for.
googleAuthRouter.get("/start", async (req, res, next) => {
  try {
    const { resourceId, tenantId } = verifyPurposeToken("gcal-connect", String(req.query.token || ""));
    const result = await pool.query("SELECT id FROM resources WHERE id = $1 AND tenant_id = $2", [resourceId, tenantId]);
    if (result.rowCount === 0) throw new NotFoundError("Resource not found");
    res.redirect(googleCalendar.getAuthUrl(resourceId));
  } catch (err) {
    next(err);
  }
});

// Google redirects here after consent, so it can't carry a bearer token. The resource round-trips in a
// signed, short-lived `state`, so a forged callback can't attach a token to someone else's resource.
googleAuthRouter.get("/callback", async (req, res, next) => {
  try {
    const code = String(req.query.code || "");
    const state = String(req.query.state || "");
    if (!code || !state) throw new ValidationError("Missing code or state from Google");

    const resourceId = await googleCalendar.handleOAuthCallback(code, state);
    const row = await pool.query("SELECT tenant_id, name FROM resources WHERE id = $1", [resourceId]);
    if (row.rows[0]) {
      await notifyStaff(row.rows[0].tenant_id, `Google Calendar connected for ${row.rows[0].name}. Free times are now checked against it.`);
    }
    res.send("<html><body>Google Calendar connected. You can close this window.</body></html>");
  } catch (err) {
    next(err);
  }
});

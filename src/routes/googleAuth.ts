import { Router } from "express";
import { requireAuth } from "../auth";
import { pool } from "../db";
import { NotFoundError, ValidationError } from "../errors";
import * as googleCalendar from "../googleCalendar";

export const googleAuthRouter = Router();

// Staff-initiated: GET /auth/google/connect?resourceId=... (requires login).
googleAuthRouter.get("/connect", requireAuth, async (req, res, next) => {
  try {
    const resourceId = String(req.query.resourceId || "");
    if (!resourceId) throw new ValidationError("resourceId query parameter is required");

    const result = await pool.query("SELECT id FROM resources WHERE id = $1 AND tenant_id = $2", [
      resourceId,
      req.staff!.tenantId,
    ]);
    if (result.rowCount === 0) throw new NotFoundError("Resource not found");

    res.redirect(googleCalendar.getAuthUrl(resourceId));
  } catch (err) {
    next(err);
  }
});

// Google redirects here after consent, so it can't carry our bearer token —
// the resourceId instead round-trips via OAuth's `state` param, set only after
// requireAuth + an ownership check in /connect above. Known POC simplification:
// `state` isn't itself signed, so treat this callback as trusted only because
// GOOGLE_REDIRECT_URI is registered to this server and resourceId is a UUID
// an attacker would have to already know.
googleAuthRouter.get("/callback", async (req, res, next) => {
  try {
    const code = String(req.query.code || "");
    const resourceId = String(req.query.state || "");
    if (!code || !resourceId) throw new ValidationError("Missing code or state from Google");

    await googleCalendar.handleOAuthCallback(code, resourceId);
    res.send("<html><body>Google Calendar connected. You can close this window.</body></html>");
  } catch (err) {
    next(err);
  }
});

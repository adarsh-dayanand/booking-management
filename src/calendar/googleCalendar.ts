import { google } from "googleapis";
import { signPurposeToken, verifyPurposeToken } from "../http/auth";
import { config, isGoogleConfigured } from "../config";
import { decrypt, encrypt } from "../lib/crypto";
import { pool } from "../lib/db";
import type { Appointment, Resource } from "../types";

// Narrowest scopes that cover what we do (https://developers.google.com/identity/protocols/oauth2/scopes#calendar):
//  - calendar.events.owned: create/change/delete/list events, only on calendars the doctor owns (their primary one)
//  - calendar.freebusy:     read availability only
// If a clinic must use a calendar the doctor doesn't own (e.g. a shared clinic calendar), swap the first for
// "https://www.googleapis.com/auth/calendar.events".
const REQUIRED_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.owned",
  "https://www.googleapis.com/auth/calendar.freebusy",
];

function assertConfigured(): void {
  if (!isGoogleConfigured) {
    throw new Error("Google Calendar is not configured (set GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI in .env)");
  }
}

function oauthClient() {
  return new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, config.google.redirectUri);
}

/** Self-serve link a doctor can open (sent over WhatsApp or from the consultant API) to connect their calendar. */
export function createConnectLink(resourceId: string, tenantId: string): string {
  const token = signPurposeToken("gcal-connect", { resourceId, tenantId }, 20 * 60);
  return `${config.baseUrl}/auth/google/start?token=${encodeURIComponent(token)}`;
}

/** URL to start connecting a resource's Google Calendar. The resource round-trips in a signed `state`. */
export function getAuthUrl(resourceId: string): string {
  assertConfigured();
  return oauthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: REQUIRED_SCOPES,
    include_granted_scopes: false,
    state: signPurposeToken("gcal-state", { resourceId }, 15 * 60),
  });
}

/** Completes the OAuth flow; returns the connected resource's id after verifying the signed state. */
export async function handleOAuthCallback(code: string, state: string): Promise<string> {
  assertConfigured();
  const { resourceId } = verifyPurposeToken("gcal-state", state);
  const client = oauthClient();
  const { tokens } = await client.getToken(code);
  // Google's granular consent lets the user untick individual permissions; refuse a partial grant up front.
  const granted = new Set((tokens.scope ?? "").split(" "));
  const missing = REQUIRED_SCOPES.filter((scope) => !granted.has(scope));
  if (missing.length > 0) {
    throw new Error("Calendar access was only partly granted. Please reconnect and tick every permission on Google's consent screen.");
  }
  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh token. Remove this app's prior access at https://myaccount.google.com/permissions and retry — Google only issues a refresh token on first consent."
    );
  }
  await pool.query(
    `UPDATE resources
     SET google_refresh_token_encrypted = $1,
         google_calendar_id = COALESCE(google_calendar_id, 'primary'),
         google_connection_status = 'connected',
         calendar_synced_at = now()
     WHERE id = $2`,
    [encrypt(tokens.refresh_token), resourceId]
  );
  return resourceId;
}

function clientFor(resource: Resource) {
  assertConfigured();
  if (!resource.googleRefreshTokenEncrypted) {
    throw new Error(`Resource ${resource.id} has no stored Google refresh token`);
  }
  const client = oauthClient();
  client.setCredentials({ refresh_token: decrypt(resource.googleRefreshTokenEncrypted) });
  return google.calendar({ version: "v3", auth: client });
}

export async function freeBusyQuery(
  resource: Resource,
  rangeStart: Date,
  rangeEnd: Date
): Promise<{ start: Date; end: Date }[]> {
  const calendar = clientFor(resource);
  const calendarId = resource.googleCalendarId || "primary";
  const response = await calendar.freebusy.query({
    requestBody: { timeMin: rangeStart.toISOString(), timeMax: rangeEnd.toISOString(), items: [{ id: calendarId }] },
  });
  const busy = response.data.calendars?.[calendarId]?.busy ?? [];
  return busy
    .filter((b) => b.start && b.end)
    .map((b) => ({ start: new Date(b.start!), end: new Date(b.end!) }));
}

async function eventDetails(
  appointment: Appointment
): Promise<{ patientName: string; patientPhone: string; serviceName: string }> {
  const result = await pool.query(
    `SELECT COALESCE(a.patient_name, p.name) AS patient_name, p.phone AS patient_phone, s.name AS service_name
     FROM appointments a
     JOIN patients p ON p.id = a.patient_id
     JOIN services s ON s.id = a.service_id
     WHERE a.id = $1`,
    [appointment.id]
  );
  return {
    patientName: result.rows[0].patient_name,
    patientPhone: result.rows[0].patient_phone,
    serviceName: result.rows[0].service_name,
  };
}

/** Pending requests sit on the calendar as tentative holds; the doctor's acceptance makes them confirmed. */
function eventStatusFields(appointment: Appointment, d: { patientName: string; serviceName: string }) {
  const pending = appointment.status === "PENDING_CONFIRMATION";
  return {
    summary: `${pending ? "[Pending] " : ""}${d.serviceName} — ${d.patientName}`,
    status: pending ? "tentative" : "confirmed",
  };
}

export async function createEvent(resource: Resource, appointment: Appointment): Promise<string> {
  const calendar = clientFor(resource);
  const details = await eventDetails(appointment);
  const response = await calendar.events.insert({
    calendarId: resource.googleCalendarId || "primary",
    requestBody: {
      ...eventStatusFields(appointment, details),
      description: `Booked via the clinic's booking bot.\nPatient phone: ${details.patientPhone}\nRef: ${appointment.id.slice(0, 6)} (appointment ${appointment.id})`,
      extendedProperties: { private: { appointmentId: appointment.id } },
      start: { dateTime: new Date(appointment.startAt).toISOString() },
      end: { dateTime: new Date(appointment.endAt).toISOString() },
    },
  });
  if (!response.data.id) throw new Error("Google Calendar did not return an event id");
  return response.data.id;
}

export async function updateEvent(resource: Resource, eventId: string, appointment: Appointment): Promise<void> {
  const calendar = clientFor(resource);
  const details = await eventDetails(appointment);
  await calendar.events.patch({
    calendarId: resource.googleCalendarId || "primary",
    eventId,
    requestBody: {
      ...eventStatusFields(appointment, details),
      start: { dateTime: new Date(appointment.startAt).toISOString() },
      end: { dateTime: new Date(appointment.endAt).toISOString() },
    },
  });
}

export async function deleteEvent(resource: Resource, eventId: string): Promise<void> {
  const calendar = clientFor(resource);
  try {
    await calendar.events.delete({ calendarId: resource.googleCalendarId || "primary", eventId });
  } catch (err: any) {
    if (err?.code === 410 || err?.code === 404) return; // already gone — not an error for our purposes
    throw err;
  }
}

export interface ChangedEvent {
  id: string;
  cancelled: boolean;
  start: Date | null;
  end: Date | null;
}

/** Events created/edited/deleted on the doctor's calendar since `updatedMin` (deleted ones included). */
export async function listChangedEvents(resource: Resource, updatedMin: Date): Promise<ChangedEvent[]> {
  const calendar = clientFor(resource);
  const events: ChangedEvent[] = [];
  let pageToken: string | undefined;
  do {
    const response = await calendar.events.list({
      calendarId: resource.googleCalendarId || "primary",
      updatedMin: updatedMin.toISOString(),
      showDeleted: true,
      singleEvents: true,
      maxResults: 250,
      pageToken,
    });
    for (const e of response.data.items ?? []) {
      if (!e.id) continue;
      events.push({
        id: e.id,
        cancelled: e.status === "cancelled",
        start: e.start?.dateTime ? new Date(e.start.dateTime) : null, // all-day events have no dateTime
        end: e.end?.dateTime ? new Date(e.end.dateTime) : null,
      });
    }
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);
  return events;
}

/** True when Google says the stored refresh token was revoked/expired and the doctor must reconnect. */
export function isAuthRevoked(err: any): boolean {
  return err?.response?.data?.error === "invalid_grant" || String(err?.message ?? "").includes("invalid_grant");
}

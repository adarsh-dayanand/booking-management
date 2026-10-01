import type { Pool, PoolClient } from "pg";
import { pool } from "../lib/db";
import { normalizePhone } from "../lib/phone";
import type { Channel } from "../types";

type Queryable = Pick<Pool | PoolClient, "query">;

export interface Patient {
  id: string;
  tenantId: string;
  name: string | null;
  nameSource: "whatsapp_profile" | "patient" | null;
  phone: string;
  phoneNormalized: string;
  phoneVerified: boolean;
  email: string | null;
  dateOfBirth: string | null;
  preferredLanguage: string | null;
  firstChannel: Channel | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** `pg` parses a DATE column as local midnight, so read local parts — going through toISOString() would shift the day. */
function dateOnly(value: Date | string | null): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

export function mapPatient(row: any): Patient {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    nameSource: row.name_source,
    phone: row.phone,
    phoneNormalized: row.phone_normalized,
    phoneVerified: Boolean(row.phone_verified_at),
    email: row.email,
    dateOfBirth: dateOnly(row.date_of_birth),
    preferredLanguage: row.preferred_language,
    firstChannel: row.first_channel,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

export interface TouchOptions {
  channel: Channel;
  /** A name we learned: the WhatsApp profile name (weak) or one the patient typed (strong). */
  name?: string | null;
  nameSource?: "whatsapp_profile" | "patient";
  /** True when the number is proven: a signed WhatsApp sender, or a completed OTP. Never downgraded. */
  verified?: boolean;
}

/**
 * Get-or-create the patient for a phone number — there is no registration step. Called on every inbound
 * message, so the first message creates the profile and later ones just refresh `last_seen_at`.
 * A patient-typed name replaces a WhatsApp profile name, but nothing ever overwrites a patient-typed name.
 */
export async function touchPatient(
  tenantId: string,
  rawPhone: string,
  options: TouchOptions,
  db: Queryable = pool
): Promise<Patient> {
  const name = options.name?.trim() || null;
  const nameSource = name ? options.nameSource ?? "patient" : null;
  const result = await db.query(
    `INSERT INTO patients (tenant_id, name, name_source, phone, phone_normalized, first_channel, phone_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $7::boolean THEN now() END)
     ON CONFLICT (tenant_id, phone_normalized) DO UPDATE SET
       last_seen_at = now(),
       phone_verified_at = COALESCE(patients.phone_verified_at, CASE WHEN $7::boolean THEN now() END),
       name = CASE
         WHEN patients.name IS NULL THEN EXCLUDED.name
         WHEN patients.name_source = 'whatsapp_profile' AND EXCLUDED.name_source = 'patient' THEN EXCLUDED.name
         ELSE patients.name END,
       name_source = CASE
         WHEN patients.name IS NULL THEN EXCLUDED.name_source
         WHEN patients.name_source = 'whatsapp_profile' AND EXCLUDED.name_source = 'patient' THEN EXCLUDED.name_source
         ELSE patients.name_source END
     RETURNING *`,
    [tenantId, name, nameSource, rawPhone.trim(), normalizePhone(rawPhone), options.channel, Boolean(options.verified)]
  );
  return mapPatient(result.rows[0]);
}

export async function getPatientByPhone(tenantId: string, rawPhone: string): Promise<Patient | null> {
  const result = await pool.query("SELECT * FROM patients WHERE tenant_id = $1 AND phone_normalized = $2", [
    tenantId,
    normalizePhone(rawPhone),
  ]);
  return result.rows[0] ? mapPatient(result.rows[0]) : null;
}

export interface PatientDetails {
  name?: string;
  email?: string;
  dateOfBirth?: string; // YYYY-MM-DD
  preferredLanguage?: string;
}

/** Records details the patient volunteered. Only the provided fields change; a typed name always wins over a profile name. */
export async function updatePatientDetails(tenantId: string, patientId: string, d: PatientDetails): Promise<Patient> {
  const result = await pool.query(
    `UPDATE patients SET
       name = COALESCE($3, name),
       name_source = CASE WHEN $3::text IS NOT NULL THEN 'patient' ELSE name_source END,
       email = COALESCE($4, email),
       date_of_birth = COALESCE($5::date, date_of_birth),
       preferred_language = COALESCE($6, preferred_language),
       last_seen_at = now()
     WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    [patientId, tenantId, d.name?.trim() || null, d.email?.trim() || null, d.dateOfBirth ?? null, d.preferredLanguage?.trim() || null]
  );
  return mapPatient(result.rows[0]);
}

export async function searchPatients(
  tenantId: string,
  filter: { phone?: string; q?: string; limit?: number }
): Promise<Patient[]> {
  const limit = Math.min(filter.limit ?? 25, 100);
  if (filter.phone) {
    const found = await getPatientByPhone(tenantId, filter.phone);
    return found ? [found] : [];
  }
  const result = await pool.query(
    `SELECT * FROM patients
     WHERE tenant_id = $1 AND ($2::text IS NULL OR name ILIKE '%' || $2 || '%' OR email ILIKE '%' || $2 || '%' OR phone_normalized LIKE '%' || $2 || '%')
     ORDER BY last_seen_at DESC LIMIT $3`,
    [tenantId, filter.q?.trim() || null, limit]
  );
  return result.rows.map(mapPatient);
}

import { pool } from "../lib/db";
import { NotFoundError } from "../errors";
import type { AvailabilityRule, Resource, Service, Tenant, TenantConfig } from "../types";

export function mapTenant(row: any): Tenant {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    timezone: row.timezone,
    confirmationPolicy: row.confirmation_policy,
    whatsappPhoneNumberId: row.whatsapp_phone_number_id,
    staffWhatsappNumber: row.staff_whatsapp_number ?? null,
    reminderHoursBefore: row.reminder_hours_before ?? 24,
    faqText: row.faq_text ?? null,
    paymentsEnabled: row.payments_enabled ?? false,
    collectPayments: row.collect_payments ?? false,
    pricing: row.consultation_pricing ?? null,
  };
}

function mapService(row: any): Service {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    durationMinutes: row.duration_minutes,
    bufferMinutes: row.buffer_minutes,
    active: row.active,
  };
}

export function mapResource(row: any): Resource {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    googleCalendarId: row.google_calendar_id,
    googleRefreshTokenEncrypted: row.google_refresh_token_encrypted,
    googleConnectionStatus: row.google_connection_status,
    active: row.active,
  };
}

function mapAvailabilityRule(row: any): AvailabilityRule {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    resourceId: row.resource_id,
    weekday: row.weekday,
    specificDate: row.specific_date,
    startTime: row.start_time,
    endTime: row.end_time,
    isClosed: row.is_closed,
  };
}

export async function loadTenantConfig(tenantSlug: string): Promise<TenantConfig> {
  const tenantResult = await pool.query("SELECT * FROM tenants WHERE slug = $1", [tenantSlug]);
  if (tenantResult.rowCount === 0) throw new NotFoundError(`Unknown clinic: ${tenantSlug}`);
  return assembleConfig(mapTenant(tenantResult.rows[0]));
}

export async function loadTenantConfigById(tenantId: string): Promise<TenantConfig> {
  const tenantResult = await pool.query("SELECT * FROM tenants WHERE id = $1", [tenantId]);
  if (tenantResult.rowCount === 0) throw new NotFoundError(`Unknown tenant: ${tenantId}`);
  return assembleConfig(mapTenant(tenantResult.rows[0]));
}

async function assembleConfig(tenant: Tenant): Promise<TenantConfig> {
  const [services, resources, availabilityRules] = await Promise.all([
    pool.query("SELECT * FROM services WHERE tenant_id = $1 AND active = true", [tenant.id]),
    pool.query("SELECT * FROM resources WHERE tenant_id = $1 AND active = true", [tenant.id]),
    pool.query("SELECT * FROM availability_rules WHERE tenant_id = $1", [tenant.id]),
  ]);

  return {
    tenant,
    services: services.rows.map(mapService),
    resources: resources.rows.map(mapResource),
    availabilityRules: availabilityRules.rows.map(mapAvailabilityRule),
  };
}

export async function getTenantSlugByWhatsappPhoneNumberId(phoneNumberId: string): Promise<string> {
  const result = await pool.query("SELECT slug FROM tenants WHERE whatsapp_phone_number_id = $1", [
    phoneNumberId,
  ]);
  if (result.rowCount === 0) throw new NotFoundError(`No tenant mapped to WhatsApp number ${phoneNumberId}`);
  return result.rows[0].slug;
}

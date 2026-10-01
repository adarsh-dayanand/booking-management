export type ConfirmationPolicy = "instant" | "staff_approval";
export type AppointmentStatus = "PENDING_CONFIRMATION" | "CONFIRMED" | "REJECTED" | "CANCELLED" | "COMPLETED";
export type Channel = "web" | "whatsapp";
export type GoogleConnectionStatus = "disconnected" | "connected" | "error";
export type CalendarSyncStatus = "pending" | "synced" | "failed" | "skipped";

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  confirmationPolicy: ConfirmationPolicy;
  whatsappPhoneNumberId: string | null;
  staffWhatsappNumber: string | null;
  reminderHoursBefore: number;
  faqText: string | null;
}

export interface Service {
  id: string;
  tenantId: string;
  name: string;
  durationMinutes: number;
  bufferMinutes: number;
  active: boolean;
}

export interface Resource {
  id: string;
  tenantId: string;
  name: string;
  googleCalendarId: string | null;
  googleRefreshTokenEncrypted: string | null;
  googleConnectionStatus: GoogleConnectionStatus;
  active: boolean;
}

export interface AvailabilityRule {
  id: string;
  tenantId: string;
  resourceId: string;
  weekday: number | null; // 0=Sunday..6=Saturday
  specificDate: string | null; // ISO date, YYYY-MM-DD
  startTime: string | null; // "HH:MM:SS"
  endTime: string | null;
  isClosed: boolean;
}

export interface TenantConfig {
  tenant: Tenant;
  services: Service[];
  resources: Resource[];
  availabilityRules: AvailabilityRule[];
}

export interface Slot {
  startAt: string; // ISO UTC
  endAt: string; // ISO UTC
}

export interface Appointment {
  id: string;
  tenantId: string;
  patientId: string;
  serviceId: string;
  resourceId: string;
  startAt: string;
  endAt: string;
  status: AppointmentStatus;
  channel: Channel;
  idempotencyKey: string;
  googleEventId: string | null;
  calendarSyncStatus: CalendarSyncStatus;
  version: number;
}

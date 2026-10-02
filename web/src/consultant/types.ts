export type Pricing =
  | { mode: "flat"; hourlyRate: number }
  | { mode: "variable"; weekdayRate: number; weekendRate: number; nightRate: number; nightStart: string; nightEnd: string };

export interface PaymentSettings {
  available: boolean;
  collectPayments: boolean;
  currency: string;
  pricing: Pricing | null;
  note?: string;
}

export type AppointmentStatus = "AWAITING_PAYMENT" | "PENDING_CONFIRMATION" | "CONFIRMED" | "REJECTED" | "CANCELLED" | "COMPLETED";
export type PaymentStatus = "created" | "paid" | "expired" | "failed" | "cancelled";

export interface Appointment {
  id: string;
  service_id: string;
  resource_id: string;
  start_at: string;
  patient_name: string | null;
  patient_phone: string;
  service_name: string;
  resource_name: string;
  channel: "web" | "whatsapp";
  status: AppointmentStatus;
  payment_status: PaymentStatus | null;
  amount_paise: number | null;
  calendar_sync_status: "pending" | "synced" | "failed" | "skipped";
}

export interface Service { id: string; name: string; durationMinutes: number; bufferMinutes: number; active: boolean }
export interface Resource { id: string; name: string; active: boolean; googleConnectionStatus: "disconnected" | "connected" | "error"; googleCalendarId: string | null }

export interface Availability {
  weekly: { weekday: number; start: string; end: string }[];
  exceptions: { date: string; closed: boolean; start?: string; end?: string }[];
}

export interface User {
  id: string;
  name: string | null;
  phone: string;
  phoneNormalized: string;
  phoneVerified: boolean;
  email: string | null;
  dateOfBirth: string | null;
  preferredLanguage: string | null;
  firstChannel: "web" | "whatsapp" | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface UserAppointment { id: string; status: AppointmentStatus; start_at: string; channel: string; service_name: string; resource_name: string }

export interface Settings {
  name: string;
  timezone: string;
  confirmationPolicy: "instant" | "staff_approval";
  staffWhatsappNumber: string | null;
  reminderHoursBefore: number;
  slotIntervalMinutes: number;
  faqText: string | null;
  whatsappPhoneNumberId: string | null;
}

export interface Overview {
  timezone: string;
  paymentsActive: boolean;
  today: number;
  next7Days: number;
  pendingApproval: number;
  awaitingPayment: number;
  syncFailed: number;
  users: number;
  newUsers30d: number;
  revenue: { todayPaise: number; last30DaysPaise: number; paidCount30d: number };
  upcoming: { id: string; status: AppointmentStatus; start_at: string; patient_name: string | null; service_name: string; resource_name: string }[];
}

export interface Transaction {
  id: string;
  status: PaymentStatus;
  amount_paise: number;
  band: string;
  created_at: string;
  paid_at: string | null;
  razorpay_payment_id: string | null;
  appointment_id: string;
  start_at: string;
  patient_name: string | null;
  patient_phone: string;
  service_name: string;
}

export interface WhatsAppConnection {
  /** own = the consultant's connected number · platform = a number the platform operator set up · none */
  mode: "own" | "platform" | "none";
  phoneNumberId: string | null;
  displayPhone: string | null;
  verifiedName: string | null;
  connectedAt: string | null;
  quality: string | null;
  template: { name: string; status: string | null } | null;
}

export interface WhatsAppInfo {
  signup: { available: boolean; appId: string | null; configId: string | null; graphVersion: string };
  connection: WhatsAppConnection;
}

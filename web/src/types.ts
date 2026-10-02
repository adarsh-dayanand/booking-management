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

export interface Appointment {
  id: string;
  start_at: string;
  patient_name: string | null;
  patient_phone: string;
  service_name: string;
  resource_name: string;
  channel: "web" | "whatsapp";
  status: AppointmentStatus;
  payment_status: "created" | "paid" | "expired" | "failed" | "cancelled" | null;
  amount_paise: number | null;
  calendar_sync_status: "pending" | "synced" | "failed" | "skipped";
}

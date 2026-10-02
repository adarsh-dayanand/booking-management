export interface Consultant {
  slug: string;
  name: string;
  timezone: string;
  confirmationPolicy: "instant" | "staff_approval";
  whatsappPhoneNumberId: string | null;
  whatsapp: { mode: "own" | "platform" | "none"; displayPhone: string | null; verifiedName: string | null; connectedAt: string | null };
  createdAt: string;
  paymentsEnabled: boolean;
  razorpayKeyId: string | null;
  razorpayMode: "test" | "live" | null;
  keySecretConfigured: boolean;
  webhookSecretConfigured: boolean;
  consultantCollectsPayments: boolean;
  webhookUrl: string;
  counts: { appointments: number; users: number; logins: number };
}

export interface Overview { consultants: number; paymentsEnabled: number; appointments30d: number; users: number; revenue30dPaise: number }
export interface Login { id: string; email: string; createdAt: string }

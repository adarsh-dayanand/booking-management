import { config } from "../config";

// The few Graph API calls needed to onboard a consultant's own WhatsApp number (Embedded Signup) and to keep it healthy.
// Each takes the consultant's business token, never the platform-wide one.

export class GraphError extends Error {
  constructor(message: string, public status?: number, public code?: number) {
    super(message);
    this.name = "GraphError";
  }
}

async function graph<T>(method: "GET" | "POST" | "DELETE", path: string, token: string, body?: object): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`https://graph.facebook.com/${config.whatsapp.graphVersion}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new GraphError(`Could not reach Meta: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await res.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) throw new GraphError(data?.error?.error_user_msg || data?.error?.message || `Meta returned ${res.status}`, res.status, data?.error?.code);
  return data as T;
}

/** Embedded Signup hands the browser a one-time `code`; only the server (holding the app secret) can turn it into a token. */
export async function exchangeCode(code: string): Promise<string> {
  const { appId, appSecret } = config.whatsapp;
  if (!appId || !appSecret) throw new GraphError("Meta app id/secret are not configured on the server");
  const params = new URLSearchParams({ client_id: appId, client_secret: appSecret, code });
  let res: Response;
  try {
    res = await fetch(`https://graph.facebook.com/${config.whatsapp.graphVersion}/oauth/access_token?${params}`, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new GraphError(`Could not reach Meta: ${err instanceof Error ? err.message : String(err)}`);
  }
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) throw new GraphError(data?.error?.message || "Meta rejected the signup code (it may have expired — try connecting again)", res.status, data?.error?.code);
  return data.access_token as string;
}

export interface WabaPhone { id: string; display_phone_number: string; verified_name: string }

/** The numbers in a WhatsApp account. Proves the token really reaches that account, and that the number belongs to it. */
export async function listWabaPhones(token: string, wabaId: string): Promise<WabaPhone[]> {
  const r = await graph<{ data?: WabaPhone[] }>("GET", `/${encodeURIComponent(wabaId)}/phone_numbers?fields=id,display_phone_number,verified_name`, token);
  return r.data ?? [];
}

/** Registers the number for the Cloud API (and sets its two-step-verification PIN). */
export async function registerPhone(token: string, phoneNumberId: string, pin: string): Promise<void> {
  await graph("POST", `/${encodeURIComponent(phoneNumberId)}/register`, token, { messaging_product: "whatsapp", pin });
}

/** Points this app's webhook at the consultant's WhatsApp account, so their incoming messages reach us. */
export async function subscribeApp(token: string, wabaId: string): Promise<void> {
  await graph("POST", `/${encodeURIComponent(wabaId)}/subscribed_apps`, token);
}

export async function unsubscribeApp(token: string, wabaId: string): Promise<void> {
  await graph("DELETE", `/${encodeURIComponent(wabaId)}/subscribed_apps`, token);
}

export const NOTIFY_TEMPLATE_NAME = "booking_update";

/**
 * The one generic message template used for anything sent outside WhatsApp's 24-hour window (reminders, approval requests,
 * verification codes). Meta requires fixed text around a variable — a body that is only "{{1}}" is rejected.
 */
export async function createNotifyTemplate(token: string, wabaId: string): Promise<"created" | "exists"> {
  try {
    await graph("POST", `/${encodeURIComponent(wabaId)}/message_templates`, token, {
      name: NOTIFY_TEMPLATE_NAME,
      language: config.whatsapp.notifyTemplateLang,
      category: "UTILITY",
      components: [
        {
          type: "BODY",
          text: "Update from your clinic: {{1}}\n\nReply to this message any time to book, reschedule or cancel.",
          example: { body_text: [["Your appointment on Mon 5 Oct at 10:00 AM is confirmed."]] },
        },
      ],
    });
    return "created";
  } catch (err) {
    if (err instanceof GraphError && /already exist|duplicate|2388023/i.test(`${err.message} ${err.code ?? ""}`)) return "exists";
    throw err;
  }
}

export async function templateStatus(token: string, wabaId: string, name: string): Promise<string | null> {
  const r = await graph<{ data?: { status?: string }[] }>("GET", `/${encodeURIComponent(wabaId)}/message_templates?name=${encodeURIComponent(name)}&fields=status`, token);
  return r.data?.[0]?.status ?? null;
}

export async function phoneDetails(token: string, phoneNumberId: string): Promise<{ display_phone_number: string; verified_name: string; quality_rating?: string }> {
  return graph("GET", `/${encodeURIComponent(phoneNumberId)}?fields=display_phone_number,verified_name,quality_rating`, token);
}

import { config } from "../config";

export function digitsOnly(phone: string): string {
  return phone.replace(/\D/g, "");
}

/**
 * Canonical identity form of a phone number: digits only, with country code. WhatsApp senders already arrive
 * that way; numbers typed on the web ("98765 43210", "09876543210", "+91 98765 43210") are normalised to match.
 */
export function normalizePhone(phone: string): string {
  let digits = digitsOnly(phone).replace(/^00/, "");
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) digits = config.defaultCountryCode + digits;
  return digits;
}

export function isPlausiblePhone(phone: string): boolean {
  const d = digitsOnly(phone);
  return d.length >= 8 && d.length <= 15;
}

export function digitsOnly(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** Tolerates a missing country code: compares the last 10 digits when both numbers have at least that many. */
export function samePhone(a: string, b: string): boolean {
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (!da || !db) return false;
  if (da.length >= 10 && db.length >= 10) return da.slice(-10) === db.slice(-10);
  return da === db;
}

export function isPlausiblePhone(phone: string): boolean {
  const d = digitsOnly(phone);
  return d.length >= 8 && d.length <= 15;
}

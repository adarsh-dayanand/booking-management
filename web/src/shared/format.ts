/** Date + time, in the clinic's zone when one is given (otherwise the browser's). */
export const formatWhen = (iso: string, tz?: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: tz });
export const formatDate = (iso: string, tz?: string): string => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium", timeZone: tz });

/** Paise → "₹1,250" / "₹1,250.50". */
export function formatRupees(paise: number): string {
  const rupees = paise / 100;
  return `₹${rupees.toLocaleString("en-IN", { minimumFractionDigits: Number.isInteger(rupees) ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export const humanize = (s: string): string => s.toLowerCase().replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

/** Download rows as a CSV file (values are quoted, and cells that look like formulas are neutralised for spreadsheets). */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  return rows.map((r) => r.map(cell).join(",")).join("\n");
}

export function downloadFile(filename: string, content: string, type = "text/csv"): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

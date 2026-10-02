export const formatWhen = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
export const formatRupees = (paise: number): string => `₹${(paise / 100).toFixed(2)}`;

import { createContext, useContext } from "react";
import { formatDate, formatWhen } from "../shared/format";

/** The consultant's own clinic: what zone its times are in and how often start times are offered. */
export interface Clinic {
  name: string;
  timezone: string;
}

export const DEFAULT_CLINIC: Clinic = { name: "", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
export const ClinicContext = createContext<Clinic>(DEFAULT_CLINIC);

/** Formatters bound to the clinic's time zone, so every page shows the same times the clinic works in. */
export function useClinic() {
  const clinic = useContext(ClinicContext);
  return { ...clinic, when: (iso: string) => formatWhen(iso, clinic.timezone), date: (iso: string) => formatDate(iso, clinic.timezone) };
}

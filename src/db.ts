import { Pool } from "pg";
import { config } from "./config";

export const pool = new Pool({ connectionString: config.databaseUrl });

/** Postgres error code for an EXCLUDE constraint violation (our no-overlap guarantee). */
export const EXCLUSION_VIOLATION = "23P01";

export function isPgError(err: unknown, code: string): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === code;
}

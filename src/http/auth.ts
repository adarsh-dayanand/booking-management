import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";
import { config } from "../config";
import { pool } from "../lib/db";
import { UnauthorizedError } from "../errors";

export interface ConsultantClaims {
  consultantUserId: string;
  tenantId: string;
  email: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      consultant?: ConsultantClaims;
    }
  }
}

function jwtSecret(): string {
  if (!config.jwtSecret) throw new Error("Missing required env var: JWT_SECRET");
  return config.jwtSecret;
}

export async function login(email: string, password: string): Promise<string> {
  const result = await pool.query("SELECT * FROM staff_users WHERE email = $1", [email]);
  if (result.rowCount === 0) throw new UnauthorizedError("Invalid email or password");

  const consultant = result.rows[0];
  const valid = await bcrypt.compare(password, consultant.password_hash);
  if (!valid) throw new UnauthorizedError("Invalid email or password");

  const claims: ConsultantClaims = { consultantUserId: consultant.id, tenantId: consultant.tenant_id, email: consultant.email };
  return jwt.sign(claims, jwtSecret(), { expiresIn: "12h" });
}

/** Express middleware: verifies the bearer token and attaches `req.consultant`. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    next(new UnauthorizedError("Missing bearer token"));
    return;
  }
  try {
    req.consultant = jwt.verify(header.slice("Bearer ".length), jwtSecret()) as ConsultantClaims;
    next();
  } catch {
    next(new UnauthorizedError("Invalid or expired token"));
  }
}

/** Short-lived signed token for one purpose (e.g. a WhatsApp-delivered Google connect link, or OAuth `state`). */
export function signPurposeToken(purpose: string, payload: Record<string, string>, expiresInSeconds: number): string {
  return jwt.sign({ ...payload, purpose }, jwtSecret(), { expiresIn: expiresInSeconds });
}

export function verifyPurposeToken(purpose: string, token: string): Record<string, string> {
  try {
    const decoded = jwt.verify(token, jwtSecret()) as Record<string, string>;
    if (decoded.purpose !== purpose) throw new Error("wrong purpose");
    return decoded;
  } catch {
    throw new UnauthorizedError("This link is invalid or has expired. Ask for a new one.");
  }
}

import { pool } from "../lib/db";
import type { Channel } from "../types";

export async function loadConversation<T extends object>(
  tenantId: string,
  channel: Channel,
  externalId: string
): Promise<{ state: Partial<T>; isNew: boolean; updatedAt: Date | null }> {
  const result = await pool.query(
    "SELECT state, updated_at FROM conversations WHERE tenant_id = $1 AND channel = $2 AND external_id = $3",
    [tenantId, channel, externalId]
  );
  if (result.rowCount === 0) return { state: {}, isNew: true, updatedAt: null };
  return { state: result.rows[0].state as Partial<T>, isNew: false, updatedAt: new Date(result.rows[0].updated_at) };
}

export async function saveConversation(
  tenantId: string,
  channel: Channel,
  externalId: string,
  state: object
): Promise<void> {
  await pool.query(
    `INSERT INTO conversations (tenant_id, channel, external_id, state, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (tenant_id, channel, external_id) DO UPDATE SET state = $4, updated_at = now()`,
    [tenantId, channel, externalId, JSON.stringify(state)]
  );
}

// Serialises turns per conversation so two quick messages can't interleave a read-modify-write
// of the history. In-process only; a multi-instance deploy needs an advisory lock instead.
const tails = new Map<string, Promise<unknown>>();
export async function withConversationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}

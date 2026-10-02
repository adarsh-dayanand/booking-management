import { vi } from "vitest";

export interface Call { method: string; path: string; query: string; body?: any; auth?: string }
type Reply = { status?: number; body?: unknown } | unknown;
type Handler = Reply | ((call: Call) => Reply);

/**
 * Stubs fetch with a route table keyed "METHOD /path" (no query string). A route may be a value or a function of the call.
 * Anything not in the table fails the test loudly instead of silently returning nothing.
 */
export function mockApi(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const unmatched: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const [path, query = ""] = String(url).split("?");
      const call: Call = {
        method: init.method ?? "GET", path, query,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
        auth: (init.headers as Record<string, string> | undefined)?.Authorization,
      };
      calls.push(call);
      const key = `${call.method} ${path}`;
      if (!(key in routes)) {
        unmatched.push(key);
        return new Response(JSON.stringify({ error: `unmocked ${key}` }), { status: 404 });
      }
      const handler = routes[key];
      const reply = (typeof handler === "function" ? (handler as (c: Call) => Reply)(call) : handler) as { status?: number; body?: unknown };
      const isEnvelope = reply && typeof reply === "object" && ("status" in reply || "body" in reply) && Object.keys(reply).every((k) => k === "status" || k === "body");
      const status = isEnvelope ? reply.status ?? 200 : 200;
      const body = isEnvelope ? reply.body : reply;
      return new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status });
    })
  );
  return { calls, unmatched, find: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path) };
}

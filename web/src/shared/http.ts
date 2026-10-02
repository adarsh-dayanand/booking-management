export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

export interface TokenStore {
  get(): string | null;
  set(token: string): void;
  clear(): void;
}

/** A token kept in a Web Storage area; every access is guarded because storage can be blocked (private windows). */
export function webTokenStore(storage: () => Storage, key: string): TokenStore {
  return {
    get: () => {
      try {
        return storage().getItem(key);
      } catch {
        return null;
      }
    },
    set: (token) => {
      try {
        storage().setItem(key, token);
      } catch {
        /* the session just won't survive a reload */
      }
    },
    clear: () => {
      try {
        storage().removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

/**
 * JSON client for one of the API's bearer-token areas. A 401 on an authenticated call clears the token and fires
 * `onUnauthorized`, which the app uses to drop back to its login screen.
 */
export function createApi(tokens: TokenStore, onUnauthorized: () => void) {
  async function request<T>(method: Method, path: string, body?: unknown, authenticated = true): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authenticated) headers.Authorization = `Bearer ${tokens.get()}`;
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401 && authenticated) {
      tokens.clear();
      onUnauthorized();
      throw new ApiError("Session expired, please log in again", 401);
    }
    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || "Request failed", res.status);
    return data as T;
  }
  return {
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body: unknown = {}) => request<T>("POST", path, body),
    put: <T>(path: string, body: unknown = {}) => request<T>("PUT", path, body),
    del: <T>(path: string) => request<T>("DELETE", path),
    /** For calls made before there is a token (login). */
    anonymous: <T>(method: Method, path: string, body?: unknown) => request<T>(method, path, body, false),
  };
}

export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : "Something went wrong");

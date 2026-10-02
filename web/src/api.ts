const TOKEN_KEY = "booking_consultant_token"; // same key as the previous dashboard, so existing sessions survive the migration

export const tokenStore = {
  get: (): string | null => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (token: string): void => {
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* storage blocked: the session just won't survive a reload */
    }
  },
  clear: (): void => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  },
};

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** Raised on a 401 from an authenticated call, so the app can drop back to the login screen. */
export const unauthorizedListeners = new Set<() => void>();

async function request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authenticated) headers.Authorization = `Bearer ${tokenStore.get()}`;
  const res = await fetch(path, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
  if (res.status === 401 && authenticated) {
    tokenStore.clear();
    unauthorizedListeners.forEach((fn) => fn());
    throw new ApiError("Session expired, please log in again", 401);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || "Request failed", res.status);
  return data as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string }>("/v1/consultant/login", { method: "POST", body: JSON.stringify({ email, password }) }, false),
  get: <T>(path: string) => request<T>(path),
  send: <T>(method: "POST" | "PUT", path: string, body: unknown = {}) => request<T>(path, { method, body: JSON.stringify(body) }),
};

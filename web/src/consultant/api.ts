import { createApi, webTokenStore } from "../shared/http";

// Same storage key the first dashboard used, so existing sessions survive the migration.
export const tokens = webTokenStore(() => localStorage, "booking_consultant_token");

export const unauthorizedListeners = new Set<() => void>();
export const api = createApi(tokens, () => unauthorizedListeners.forEach((fn) => fn()));

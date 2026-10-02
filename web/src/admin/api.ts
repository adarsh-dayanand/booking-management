import { createApi, webTokenStore } from "../shared/http";

// sessionStorage, not localStorage: the admin token is powerful, so it should end with the browser tab.
export const tokens = webTokenStore(() => sessionStorage, "booking_admin_token");

export const unauthorizedListeners = new Set<() => void>();
export const api = createApi(tokens, () => unauthorizedListeners.forEach((fn) => fn()));

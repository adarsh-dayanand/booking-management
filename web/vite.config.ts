import { resolve } from "path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Two single-page apps from one codebase: /consultant/ (clinic dashboard) and /admin/ (platform admin).
// `npm run build:web` writes web/dist, which the API server serves; in dev (`npm run dev:web`) Vite serves both
// apps and proxies /v1 to the running API, so there is no CORS setup.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: { input: { consultant: resolve(__dirname, "consultant/index.html"), admin: resolve(__dirname, "admin/index.html") } },
  },
  server: { port: 5173, proxy: { "/v1": process.env.API_URL ?? "http://localhost:4000" } },
  test: { environment: "jsdom", globals: true, setupFiles: ["./src/test-setup.ts"] },
});

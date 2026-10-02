import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Built into the API server's static dir and served at /consultant/. In dev (`npm run dev:web`) Vite serves the app
// and proxies API calls to the running server, so there is no CORS setup.
export default defineConfig({
  base: "/consultant/",
  plugins: [react()],
  build: { outDir: "../public/consultant", emptyOutDir: true },
  server: { port: 5173, proxy: { "/v1": process.env.API_URL ?? "http://localhost:4000" } },
  test: { environment: "jsdom", globals: true, setupFiles: ["./src/test-setup.ts"] },
});

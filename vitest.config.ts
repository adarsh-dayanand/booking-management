import { defineConfig } from "vitest/config";

// The React dashboard in web/ has its own config (jsdom); keep it out of the server's test run.
export default defineConfig({ test: { exclude: ["web/**", "node_modules/**", "dist/**"] } });

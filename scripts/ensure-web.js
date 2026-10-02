// Builds the React dashboards (web/) when web/dist is missing or older than the sources, so `npm run dev` and
// `npm start` always serve /consultant/ and /admin/ instead of a 404. Skipped with SKIP_WEB_BUILD=1.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const webDir = path.join(root, "web");
const dist = path.join(webDir, "dist");

function newest(dir) {
  let latest = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    latest = Math.max(latest, entry.isDirectory() ? newest(full) : fs.statSync(full).mtimeMs);
  }
  return latest;
}

if (process.env.SKIP_WEB_BUILD === "1" || !fs.existsSync(webDir)) process.exit(0);

const outputs = ["consultant/index.html", "admin/index.html"].map((f) => path.join(dist, f));
const builtAt = outputs.every((f) => fs.existsSync(f)) ? Math.min(...outputs.map((f) => fs.statSync(f).mtimeMs)) : 0;
if (builtAt >= newest(webDir)) process.exit(0);

console.log(builtAt ? "Dashboards are out of date — rebuilding (web/)…" : "Dashboards aren't built yet — building (web/)…");
const result = spawnSync("npm", ["run", "build", "-w", "web"], { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
if (result.status !== 0) {
  console.error("\nCould not build the dashboards; the API will still start, but /consultant/ and /admin/ won't load.\n");
}

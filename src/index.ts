import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import swaggerUiDist from "swagger-ui-dist";
import express, { NextFunction, Request, Response } from "express";
import { config } from "./config";
import { pool } from "./lib/db";
import { AppError } from "./errors";
import { openApiSpec } from "./http/openapi";
import { consultantRouter } from "./http/routes/consultant";
import { adminRouter } from "./http/routes/admin";
import { razorpayWebhookRouter } from "./http/routes/razorpayWebhook";
import { googleAuthRouter } from "./http/routes/googleAuth";
import { startScheduler } from "./jobs/scheduler";
import { webChatRouter } from "./http/routes/webChat";
import { whatsappWebhookRouter } from "./http/routes/whatsappWebhook";

declare module "express-serve-static-core" {
  interface Request {
    correlationId?: string;
    rawBody?: Buffer;
  }
}

const app = express();

app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as Request).rawBody = buf;
    },
  })
);

app.use((req: Request, res: Response, next: NextFunction) => {
  req.correlationId = (req.headers["x-correlation-id"] as string) || randomUUID();
  res.setHeader("x-correlation-id", req.correlationId);
  next();
});

// Old bookmark of the first (vanilla) dashboard -> the React app.
app.get("/consultant.html", (_req, res) => res.redirect(301, "/consultant/"));
// If the dashboards haven't been built, say so instead of a bare 404 (npm run dev / start normally builds them first).
const webDist = path.join(__dirname, "..", "web", "dist");
app.get(["/consultant", "/consultant/*", "/admin", "/admin/*"], (req, res, next) => {
  if (fs.existsSync(path.join(webDist, "consultant", "index.html")) && fs.existsSync(path.join(webDist, "admin", "index.html"))) return next();
  res.status(503).type("html").send(`<!doctype html><meta charset="utf-8"><title>Dashboards not built</title>
<body style="font:16px/1.6 system-ui;max-width:560px;margin:12vh auto;padding:0 20px;color:#0d1512">
<h1 style="font-size:1.5rem">The dashboards aren't built yet</h1>
<p>The consultant dashboard and admin console are React apps that need a one-time build:</p>
<pre style="background:#eef5f2;padding:12px 14px;border-radius:12px">npm run build:web</pre>
<p>Then reload this page. (<code>npm run dev</code> and <code>npm start</code> do this automatically.)</p></body>`);
});

// The embeddable widget snippet + iframe chat UI.
app.use(express.static(path.join(__dirname, "..", "public")));
// The React apps (built from web/): the consultant dashboard at /consultant/ and the admin console at /admin/.
app.use(express.static(webDist));

if (config.docsEnabled) {
  app.get("/openapi.json", (_req, res) => res.json(openApiSpec));
  app.use("/docs/assets", express.static(swaggerUiDist.getAbsoluteFSPath()));
  app.get(["/docs", "/docs/"], (_req, res) => {
    res.type("html").send(`<!doctype html>
<html><head><meta charset="utf-8"><title>Clinic Booking Agent API</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/docs/assets/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="/docs/assets/swagger-ui-bundle.js"></script>
<script>
  window.ui = SwaggerUIBundle({
    url: "/openapi.json", dom_id: "#ui", deepLinking: true, persistAuthorization: true,
    tryItOutEnabled: true, displayRequestDuration: true, docExpansion: "list",
  });
</script></body></html>`);
  });
}

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "db_unreachable" });
  }
});

app.use("/v1/public", webChatRouter);
app.use("/v1/consultant", consultantRouter);
app.use("/v1/admin", adminRouter);
app.use("/auth/google", googleAuthRouter);
app.use("/v1/webhooks/whatsapp", whatsappWebhookRouter);
app.use("/v1/webhooks/razorpay", razorpayWebhookRouter);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message, correlationId: req.correlationId });
    return;
  }
  console.error(`[error] [${req.correlationId}]`, err);
  res.status(500).json({ error: "Internal server error", correlationId: req.correlationId });
});

app.listen(config.port, () => {
  console.log(`Booking management bot listening on ${config.baseUrl}`);
  if (config.docsEnabled) console.log(`Swagger UI: ${config.baseUrl}/docs`);
  startScheduler();
});

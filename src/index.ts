import { randomUUID } from "crypto";
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

// Old bookmark of the vanilla dashboard -> the React app (built from web/ into public/consultant/).
app.get("/consultant.html", (_req, res) => res.redirect(301, "/consultant/"));
// The embeddable widget snippet + iframe chat UI + the consultant dashboard.
app.use(express.static(path.join(__dirname, "..", "public")));

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

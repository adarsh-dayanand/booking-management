import { randomUUID } from "crypto";
import path from "path";
import express, { NextFunction, Request, Response } from "express";
import { config } from "./config";
import { pool } from "./db";
import { AppError } from "./errors";
import { adminRouter } from "./routes/admin";
import { googleAuthRouter } from "./routes/googleAuth";
import { webChatRouter } from "./routes/webChat";
import { whatsappWebhookRouter } from "./routes/whatsappWebhook";

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

// The embeddable widget snippet + iframe chat UI + the staff dashboard.
app.use(express.static(path.join(__dirname, "..", "public")));

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch {
    res.status(503).json({ status: "db_unreachable" });
  }
});

app.use("/v1/public", webChatRouter);
app.use("/v1/admin", adminRouter);
app.use("/auth/google", googleAuthRouter);
app.use("/v1/webhooks/whatsapp", whatsappWebhookRouter);

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
});

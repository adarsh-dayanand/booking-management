import { Request, Response, Router } from "express";
import { buildSystemPrompt, type AgentEvent } from "../../chat/agent";
import { toolDeclarations } from "../../chat/agentTools";
import { config } from "../../config";
import { handleIncomingMessage } from "../../chat/conversation";
import { pool } from "../../lib/db";
import { ForbiddenError, ValidationError } from "../../errors";
import { DEFAULT_MODEL, isAiConfigured } from "../../chat/gemini";
import { isPlausiblePhone, normalizePhone } from "../../lib/phone";
import { touchPatient } from "../../booking/patients";
import { loadConversation, saveConversation, withConversationLock } from "../../chat/conversationStore";
import { sendPhoneOtp, verifyPhoneOtp } from "../../channels/phoneOtp";
import { allow, rateLimit } from "../../lib/rateLimit";
import { loadTenantConfig } from "../../booking/tenant";

export const webChatRouter = Router();

function boolQuery(req: Request, name: string): boolean {
  const value = req.query[name];
  if (value === undefined) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ValidationError(`${name} must be "true" or "false"`);
}

/** Minimal Server-Sent Events writer; headers go out lazily so early failures can still be normal JSON errors. */
function sseWriter(res: Response) {
  let started = false;
  return {
    get started() {
      return started;
    },
    send(event: string, data: unknown) {
      if (!started) {
        res.status(200).set({
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no", // stop nginx-style proxies from buffering the stream
        });
        res.flushHeaders();
        started = true;
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
  };
}

// POST /v1/public/:tenantSlug/chat/messages — the endpoint the embeddable widget calls (and Swagger can).
//   ?stream=false (default)  one JSON response
//   ?stream=true             Server-Sent Events: text_delta (as the model writes), tool_call / tool_result (if trace), done
//   ?trace=true              include what the agent did (tool calls + results); only when AGENT_TRACE allows it
// sessionId is a client-generated UUID persisted in the iframe's own localStorage, standing in for "who is this visitor".
webChatRouter.post("/:tenantSlug/chat/messages", rateLimit("chat-ip", 60, 60_000), async (req, res, next) => {
  const sse = sseWriter(res);
  try {
    const { tenantSlug } = req.params;
    const { sessionId, message, phone, name } = req.body ?? {};
    if (typeof sessionId !== "string" || !sessionId || sessionId.length > 100) throw new ValidationError("sessionId is required");
    if (typeof message !== "string") throw new ValidationError("message is required");
    const stream = boolQuery(req, "stream");
    const trace = boolQuery(req, "trace");
    if (trace && !config.agentTraceEnabled) throw new ForbiddenError("trace is disabled on this server (set AGENT_TRACE=1)");

    if (!allow(`chat-session:${sessionId}`, 20, 60_000)) {
      const replyText = "You're sending messages very quickly — please wait a moment.";
      if (stream) {
        sse.send("done", { replyText });
        res.end();
      } else {
        res.json({ replyText });
      }
      return;
    }

    const events: AgentEvent[] = [];
    const onEvent = (event: AgentEvent) => {
      if (event.type === "text_delta") {
        if (stream) sse.send("text_delta", { step: event.step, text: event.text });
        return;
      }
      if (trace) {
        events.push(event);
        if (stream) sse.send(event.type, event);
      }
    };

    // Optional contact details from the host page. Captured at once as an UNVERIFIED contact (no registration);
    // the number only unlocks stored data after the visitor proves it with a WhatsApp code.
    let claimedPhone: string | undefined;
    if (typeof phone === "string" && phone.trim()) {
      if (!isPlausiblePhone(phone)) throw new ValidationError("phone doesn't look valid");
      const tenantConfig = await loadTenantConfig(tenantSlug);
      await touchPatient(tenantConfig.tenant.id, phone, {
        channel: "web",
        name: typeof name === "string" ? name : undefined,
        nameSource: "patient",
      });
      claimedPhone = normalizePhone(phone);
    }

    const mode = isAiConfigured() ? "agent" : "guided";
    const result = await handleIncomingMessage(tenantSlug, "web", sessionId, message, { stream, onEvent, claimedPhone });
    const body = { ...result, mode, ...(trace ? { trace: events } : {}) };
    if (stream) {
      sse.send("done", body);
      res.end();
    } else {
      res.json(body);
    }
  } catch (err) {
    if (sse.started) {
      sse.send("error", { message: err instanceof Error ? err.message : "Internal error" });
      res.end();
    } else {
      next(err);
    }
  }
});

// DELETE /v1/public/:tenantSlug/chat/sessions/:sessionId — forget a conversation (handy when testing in Swagger).
webChatRouter.delete("/:tenantSlug/chat/sessions/:sessionId", async (req, res, next) => {
  try {
    const tenantConfig = await loadTenantConfig(req.params.tenantSlug);
    await pool.query("DELETE FROM conversations WHERE tenant_id = $1 AND channel = 'web' AND external_id = $2", [
      tenantConfig.tenant.id,
      req.params.sessionId,
    ]);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

// GET /v1/public/:tenantSlug/agent/info — shows exactly how the agent is set up for this clinic. Dev/trace only.
webChatRouter.get("/:tenantSlug/agent/info", async (req, res, next) => {
  try {
    if (!config.agentTraceEnabled) throw new ForbiddenError("agent info is disabled on this server (set AGENT_TRACE=1)");
    const tenantConfig = await loadTenantConfig(req.params.tenantSlug);
    const agent = isAiConfigured();
    res.json({
      mode: agent ? "agent" : "guided",
      note: agent ? undefined : "No GEMINI_API_KEY set: the deterministic numbered-menu flow is running instead of the agent.",
      model: agent ? config.gemini.model || DEFAULT_MODEL : null,
      bookingFlow: tenantConfig.tenant.confirmationPolicy,
      systemPrompt: buildSystemPrompt(tenantConfig),
      tools: toolDeclarations,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Phone-number authentication for web visitors (the agent can do the same through its tools).
// 1) POST .../phone/otp    sends a 6-digit code to the number over WhatsApp
// 2) POST .../phone/verify checks it; the session is then bound to that number and may use its bookings/profile
// ---------------------------------------------------------------------------

async function mergeSessionState(tenantId: string, sessionId: string, patch: Record<string, unknown>) {
  await withConversationLock(`${tenantId}:web:${sessionId}`, async () => {
    const { state } = await loadConversation<Record<string, unknown>>(tenantId, "web", sessionId);
    await saveConversation(tenantId, "web", sessionId, { history: [], ...state, ...patch });
  });
}

webChatRouter.post("/:tenantSlug/chat/sessions/:sessionId/phone/otp", rateLimit("otp-ip", 10, 60 * 60_000), async (req, res, next) => {
  try {
    const phone = req.body?.phone;
    if (typeof phone !== "string" || !isPlausiblePhone(phone)) throw new ValidationError("a valid phone is required");
    const tenantConfig = await loadTenantConfig(req.params.tenantSlug);
    await touchPatient(tenantConfig.tenant.id, phone, { channel: "web" }); // capture the contact immediately, unverified
    await mergeSessionState(tenantConfig.tenant.id, req.params.sessionId, { claimedPhone: normalizePhone(phone) });
    const result = await sendPhoneOtp(tenantConfig.tenant, phone);
    res.status(result.sent || "devCode" in result ? 200 : 502).json(result);
  } catch (err) {
    next(err);
  }
});

webChatRouter.post("/:tenantSlug/chat/sessions/:sessionId/phone/verify", rateLimit("otp-verify-ip", 30, 60 * 60_000), async (req, res, next) => {
  try {
    const { phone, code } = req.body ?? {};
    if (typeof phone !== "string" || typeof code !== "string") throw new ValidationError("phone and code are required");
    const tenantConfig = await loadTenantConfig(req.params.tenantSlug);
    const result = await verifyPhoneOtp(tenantConfig.tenant.id, phone, code);
    if (!result.verified) {
      res.status(401).json(result);
      return;
    }
    const patient = await touchPatient(tenantConfig.tenant.id, phone, { channel: "web", verified: true });
    await mergeSessionState(tenantConfig.tenant.id, req.params.sessionId, { verifiedPhone: result.phone });
    res.json({ verified: true, patient: { name: patient.name, email: patient.email, preferredLanguage: patient.preferredLanguage, phone: `+${patient.phoneNormalized}` } });
  } catch (err) {
    next(err);
  }
});

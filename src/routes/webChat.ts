import { Router } from "express";
import { handleIncomingMessage } from "../guidedFlow";
import { ValidationError } from "../errors";

export const webChatRouter = Router();

// POST /v1/public/:tenantSlug/chat/messages — the only endpoint the embeddable
// widget calls. sessionId is a client-generated UUID persisted in the
// iframe's own localStorage, standing in for "who is this visitor".
webChatRouter.post("/:tenantSlug/chat/messages", async (req, res, next) => {
  try {
    const { tenantSlug } = req.params;
    const { sessionId, message } = req.body ?? {};
    if (typeof sessionId !== "string" || !sessionId) throw new ValidationError("sessionId is required");
    if (typeof message !== "string") throw new ValidationError("message is required");

    const result = await handleIncomingMessage(tenantSlug, "web", sessionId, message);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

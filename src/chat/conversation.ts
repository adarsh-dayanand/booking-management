import { handleAgentMessage, type AgentMessageOptions } from "./agent";
import { isAiConfigured } from "./gemini";
import { handleGuidedMessage, type ChatResponse } from "./guidedFlow";
import { loadTenantConfig } from "../booking/tenant";
import type { Channel } from "../types";

/**
 * The single entry point for patient chat on both channels. With GEMINI_API_KEY set, the Gemini agent
 * handles the conversation (its tools call booking.ts, the only thing that changes appointments);
 * without it, the deterministic numbered-menu flow runs.
 */
export async function handleIncomingMessage(
  tenantSlug: string,
  channel: Channel,
  externalId: string,
  messageText: string,
  options: AgentMessageOptions = {}
): Promise<ChatResponse> {
  if (!isAiConfigured()) return handleGuidedMessage(tenantSlug, channel, externalId, messageText);
  const config = await loadTenantConfig(tenantSlug);
  return handleAgentMessage(config, channel, externalId, messageText, options);
}

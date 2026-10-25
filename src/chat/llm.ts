import { config } from "../config";
import * as anthropic from "./anthropic";
import * as gemini from "./gemini";
import * as openai from "./openai";
import { LlmError } from "./llmError";
import type { GeminiRequest, GeminiResponse } from "./gemini";

// The booking agent keeps its conversation in Gemini's shape; each provider translates to and from its own API.
// Which one runs is decided by .env alone (LLM_PROVIDER, LLM_API_KEY, LLM_MODEL, LLM_BASE_URL).

export type LlmProvider = "gemini" | "openai" | "anthropic";

/** The provider in use, or null when none is configured (the numbered-menu flow runs instead). */
export function activeProvider(): LlmProvider | null {
  const { provider, known, apiKey } = config.llm;
  if (provider && !known) throw new LlmError(`LLM_PROVIDER must be one of gemini, openai, anthropic (got "${provider}")`);
  return known && apiKey ? known : null;
}

export const isAiConfigured = (): boolean => {
  try {
    return activeProvider() !== null;
  } catch (err) {
    console.error(`[llm] ${(err as Error).message}; falling back to the numbered-menu flow`);
    return false;
  }
};

const DEFAULT_MODELS: Record<LlmProvider, string> = {
  gemini: gemini.DEFAULT_MODEL,
  openai: openai.DEFAULT_OPENAI_MODEL,
  anthropic: anthropic.DEFAULT_ANTHROPIC_MODEL,
};

export function activeModel(): string | null {
  const provider = isAiConfigured() ? activeProvider() : null;
  return provider ? config.llm.model || DEFAULT_MODELS[provider] : null;
}

const implementation = () => {
  const provider = activeProvider();
  if (!provider) throw new LlmError("No LLM is configured (set LLM_PROVIDER and LLM_API_KEY)");
  return { gemini, openai, anthropic }[provider];
};

export const generate = (request: GeminiRequest, timeoutMs?: number): Promise<GeminiResponse> => implementation().generate(request, timeoutMs);

export const generateStream = (request: GeminiRequest, onText: (text: string) => void, timeoutMs?: number): Promise<GeminiResponse> =>
  implementation().generateStream(request, onText, timeoutMs);

export { LlmError };

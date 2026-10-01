import { config } from "./config";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
export const DEFAULT_MODEL = "gemini-2.5-flash";

export const isAiConfigured = (): boolean => Boolean(config.gemini.apiKey);

export interface GeminiPart {
  text?: string;
  thought?: boolean;
  functionCall?: { name: string; args?: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  [key: string]: unknown; // thought signatures etc. must round-trip untouched
}

export interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

export interface GeminiRequest {
  systemInstruction?: { parts: { text: string }[] };
  contents: GeminiContent[];
  tools?: { functionDeclarations: object[] }[];
  generationConfig?: Record<string, unknown>;
}

export interface GeminiResponse {
  candidates?: { content?: GeminiContent; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

export class GeminiError extends Error {}

export async function generate(request: GeminiRequest, timeoutMs = 25_000): Promise<GeminiResponse> {
  if (!config.gemini.apiKey) throw new GeminiError("GEMINI_API_KEY is not set");
  const model = config.gemini.model || DEFAULT_MODEL;
  const response = await fetch(`${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": config.gemini.apiKey, "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new GeminiError(`Gemini request failed (${response.status}): ${await response.text()}`);
  return (await response.json()) as GeminiResponse;
}

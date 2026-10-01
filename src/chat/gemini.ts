import { config } from "../config";

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
  const response = await fetch(`${config.gemini.baseUrl}/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": config.gemini.apiKey, "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new GeminiError(`Gemini request failed (${response.status}): ${await response.text()}`);
  return (await response.json()) as GeminiResponse;
}

/**
 * Streaming variant (`streamGenerateContent?alt=sse`): calls `onText` for each text fragment as it arrives and
 * returns the same aggregated shape as `generate`. Parts are kept verbatim (not merged) so function calls and
 * thought signatures round-trip unchanged.
 */
export async function generateStream(
  request: GeminiRequest,
  onText: (text: string) => void,
  timeoutMs = 60_000
): Promise<GeminiResponse> {
  if (!config.gemini.apiKey) throw new GeminiError("GEMINI_API_KEY is not set");
  const model = config.gemini.model || DEFAULT_MODEL;
  const response = await fetch(`${config.gemini.baseUrl}/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: "POST",
    headers: { "x-goog-api-key": config.gemini.apiKey, "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || !response.body) {
    throw new GeminiError(`Gemini stream failed (${response.status}): ${await response.text()}`);
  }

  const parts: GeminiPart[] = [];
  let finishReason: string | undefined;
  let blockReason: string | undefined;

  const handleEvent = (raw: string) => {
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (!data) return;
    const chunk = JSON.parse(data) as GeminiResponse;
    blockReason = chunk.promptFeedback?.blockReason ?? blockReason;
    const candidate = chunk.candidates?.[0];
    finishReason = candidate?.finishReason ?? finishReason;
    for (const part of candidate?.content?.parts ?? []) {
      parts.push(part);
      if (part.text && !part.thought) onText(part.text);
    }
  };

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary: RegExpMatchArray | null;
    while ((boundary = buffer.match(/\r?\n\r?\n/))) {
      handleEvent(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index! + boundary[0].length);
    }
  }
  if (buffer.trim()) handleEvent(buffer);

  return {
    candidates: [{ content: parts.length ? { role: "model", parts } : undefined, finishReason }],
    promptFeedback: blockReason ? { blockReason } : undefined,
  };
}

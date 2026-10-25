import { config } from "../config";
import { LlmError } from "./llmError";
import { readSse } from "./sse";
import { toolIdsFor } from "./toolIds";
import type { GeminiPart, GeminiRequest, GeminiResponse } from "./gemini";

// OpenAI Chat Completions — also what OpenRouter, Groq, Together, Azure OpenAI, Ollama, vLLM, ... speak (set OPENAI_BASE_URL).

export const DEFAULT_OPENAI_MODEL = "gpt-4.1-mini";

const isOpenAiProper = (): boolean => !config.llm.baseUrl || config.llm.baseUrl === "https://api.openai.com/v1";
// Reasoning models (o-series, gpt-5) reject a custom temperature.
const fixedTemperature = (model: string): boolean => /^(o\d|gpt-5)/.test(model);

export function toOpenAiRequest(request: GeminiRequest, model: string, stream: boolean, openAiProper = true): Record<string, unknown> {
  const ids = toolIdsFor(request.contents);
  const messages: Record<string, unknown>[] = [];
  const system = request.systemInstruction?.parts.map((p) => p.text).join("\n");
  if (system) messages.push({ role: "system", content: system });

  request.contents.forEach((content, c) => {
    const text = content.parts.filter((p) => !p.thought && p.text).map((p) => p.text).join("");
    if (content.role === "model") {
      const toolCalls = content.parts
        .map((p, i) => ({ p, id: ids[c][i] }))
        .filter(({ p }) => p.functionCall)
        .map(({ p, id }) => ({ id, type: "function", function: { name: p.functionCall!.name, arguments: JSON.stringify(p.functionCall!.args ?? {}) } }));
      messages.push({ role: "assistant", content: text || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      return;
    }
    content.parts.forEach((p, i) => {
      if (p.functionResponse) messages.push({ role: "tool", tool_call_id: ids[c][i], content: JSON.stringify(p.functionResponse.response) });
    });
    if (text) messages.push({ role: "user", content: text });
  });

  const generation = request.generationConfig ?? {};
  const tools = (request.tools ?? []).flatMap((t) => t.functionDeclarations as { name: string; description: string; parameters: object }[]);
  return {
    model,
    messages,
    ...(tools.length ? { tools: tools.map((fn) => ({ type: "function", function: fn })) } : {}),
    ...(typeof generation.temperature === "number" && !fixedTemperature(model) ? { temperature: generation.temperature } : {}),
    ...(typeof generation.maxOutputTokens === "number"
      ? { [openAiProper ? "max_completion_tokens" : "max_tokens"]: generation.maxOutputTokens }
      : {}),
    ...(stream ? { stream: true } : {}),
  };
}

interface ToolCall { id?: string; function?: { name?: string; arguments?: string } }

function toGeminiResponse(text: string, toolCalls: ToolCall[], finishReason?: string): GeminiResponse {
  const parts: GeminiPart[] = [];
  if (text) parts.push({ text });
  for (const call of toolCalls) {
    let args: Record<string, unknown> = {};
    try {
      args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      throw new LlmError(`OpenAI returned malformed tool arguments for ${call.function?.name}`);
    }
    parts.push({ functionCall: { name: call.function?.name ?? "", args }, toolCallId: call.id });
  }
  return { candidates: [{ content: parts.length ? { role: "model", parts } : undefined, finishReason }] };
}

async function post(request: GeminiRequest, stream: boolean, timeoutMs: number): Promise<Response> {
  if (!config.llm.apiKey) throw new LlmError("LLM_API_KEY is not set");
  const model = config.llm.model || DEFAULT_OPENAI_MODEL;
  const response = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${config.llm.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(toOpenAiRequest(request, model, stream, isOpenAiProper())),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || !response.body) throw new LlmError(`OpenAI request failed (${response.status}): ${await response.text()}`);
  return response;
}

export async function generate(request: GeminiRequest, timeoutMs = 25_000): Promise<GeminiResponse> {
  const body = (await (await post(request, false, timeoutMs)).json()) as { choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] }; finish_reason?: string }[] };
  const choice = body.choices?.[0];
  return toGeminiResponse(choice?.message?.content ?? "", choice?.message?.tool_calls ?? [], choice?.finish_reason);
}

export async function generateStream(request: GeminiRequest, onText: (text: string) => void, timeoutMs = 60_000): Promise<GeminiResponse> {
  const response = await post(request, true, timeoutMs);
  let text = "";
  let finishReason: string | undefined;
  const calls: ToolCall[] = []; // streamed in fragments, keyed by index
  await readSse(response.body, (data) => {
    const choice = JSON.parse(data).choices?.[0];
    if (!choice) return;
    finishReason = choice.finish_reason ?? finishReason;
    const delta = choice.delta ?? {};
    if (delta.content) {
      text += delta.content;
      onText(delta.content);
    }
    for (const fragment of delta.tool_calls ?? []) {
      const call = (calls[fragment.index ?? 0] ??= { function: { name: "", arguments: "" } });
      if (fragment.id) call.id = fragment.id;
      if (fragment.function?.name) call.function!.name += fragment.function.name;
      if (fragment.function?.arguments) call.function!.arguments += fragment.function.arguments;
    }
  });
  return toGeminiResponse(text, calls.filter(Boolean), finishReason);
}

import { config } from "../config";
import { LlmError } from "./llmError";
import { readSse } from "./sse";
import { toolIdsFor } from "./toolIds";
import type { GeminiPart, GeminiRequest, GeminiResponse } from "./gemini";

// Anthropic Messages API (Claude).

export const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5-5";

export function toAnthropicRequest(request: GeminiRequest, model: string, stream: boolean): Record<string, unknown> {
  const ids = toolIdsFor(request.contents);
  const messages = request.contents
    .map((content, c) => {
      const blocks: Record<string, unknown>[] = [];
      content.parts.forEach((p, i) => {
        if (p.functionCall) blocks.push({ type: "tool_use", id: ids[c][i], name: p.functionCall.name, input: p.functionCall.args ?? {} });
        else if (p.functionResponse) blocks.push({ type: "tool_result", tool_use_id: ids[c][i], content: JSON.stringify(p.functionResponse.response) });
        else if (p.text && !p.thought) blocks.push({ type: "text", text: p.text });
      });
      // tool_result blocks must come first in a user turn
      blocks.sort((a, b) => Number(b.type === "tool_result") - Number(a.type === "tool_result"));
      return { role: content.role === "model" ? "assistant" : "user", content: blocks };
    })
    .filter((m) => m.content.length > 0);

  const generation = request.generationConfig ?? {};
  const tools = (request.tools ?? []).flatMap((t) => t.functionDeclarations as { name: string; description: string; parameters: object }[]);
  const system = request.systemInstruction?.parts.map((p) => p.text).join("\n");
  return {
    model,
    max_tokens: typeof generation.maxOutputTokens === "number" ? generation.maxOutputTokens : 1024,
    messages,
    ...(system ? { system } : {}),
    ...(tools.length ? { tools: tools.map((fn) => ({ name: fn.name, description: fn.description, input_schema: fn.parameters })) } : {}),
    ...(typeof generation.temperature === "number" ? { temperature: generation.temperature } : {}),
    ...(stream ? { stream: true } : {}),
  };
}

function toGeminiResponse(parts: GeminiPart[], finishReason?: string): GeminiResponse {
  return { candidates: [{ content: parts.length ? { role: "model", parts } : undefined, finishReason }] };
}

async function post(request: GeminiRequest, stream: boolean, timeoutMs: number): Promise<Response> {
  if (!config.llm.apiKey) throw new LlmError("LLM_API_KEY is not set");
  const model = config.llm.model || DEFAULT_ANTHROPIC_MODEL;
  const response = await fetch(`${config.llm.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": config.llm.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(toAnthropicRequest(request, model, stream)),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok || !response.body) throw new LlmError(`Anthropic request failed (${response.status}): ${await response.text()}`);
  return response;
}

export async function generate(request: GeminiRequest, timeoutMs = 25_000): Promise<GeminiResponse> {
  const body = (await (await post(request, false, timeoutMs)).json()) as { content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[]; stop_reason?: string };
  const parts: GeminiPart[] = [];
  for (const block of body.content ?? []) {
    if (block.type === "text" && block.text) parts.push({ text: block.text });
    else if (block.type === "tool_use") parts.push({ functionCall: { name: block.name!, args: block.input ?? {} }, toolCallId: block.id });
  }
  return toGeminiResponse(parts, body.stop_reason);
}

export async function generateStream(request: GeminiRequest, onText: (text: string) => void, timeoutMs = 60_000): Promise<GeminiResponse> {
  const response = await post(request, true, timeoutMs);
  const parts: GeminiPart[] = [];
  const toolJson: string[] = []; // tool input arrives as JSON fragments, per content block index
  let finishReason: string | undefined;
  await readSse(response.body, (data) => {
    const event = JSON.parse(data);
    if (event.type === "error") throw new LlmError(`Anthropic stream failed (${event.error?.type === "overloaded_error" ? 529 : 500}): ${event.error?.message}`);
    if (event.type === "content_block_start") {
      const block = event.content_block;
      if (block.type === "tool_use") {
        parts[event.index] = { functionCall: { name: block.name, args: {} }, toolCallId: block.id };
        toolJson[event.index] = "";
      } else if (block.type === "text") parts[event.index] = { text: "" };
    } else if (event.type === "content_block_delta") {
      const delta = event.delta;
      if (delta.type === "text_delta" && delta.text) {
        (parts[event.index] ??= { text: "" }).text += delta.text;
        onText(delta.text);
      } else if (delta.type === "input_json_delta") toolJson[event.index] = (toolJson[event.index] ?? "") + delta.partial_json;
    } else if (event.type === "message_delta") finishReason = event.delta?.stop_reason ?? finishReason;
  });
  toolJson.forEach((json, i) => {
    if (json && parts[i]?.functionCall) {
      try {
        parts[i].functionCall!.args = JSON.parse(json);
      } catch {
        throw new LlmError(`Anthropic returned malformed tool arguments for ${parts[i].functionCall!.name}`);
      }
    }
  });
  return toGeminiResponse(parts.filter((p) => p && (p.functionCall || p.text)), finishReason);
}

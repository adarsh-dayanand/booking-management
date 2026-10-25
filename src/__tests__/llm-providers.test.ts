import { describe, expect, it } from "vitest";
import { toAnthropicRequest } from "../chat/anthropic";
import { toOpenAiRequest } from "../chat/openai";
import type { GeminiRequest } from "../chat/gemini";

const request: GeminiRequest = {
  systemInstruction: { parts: [{ text: "You are a clinic assistant." }] },
  contents: [
    { role: "user", parts: [{ text: "book me tomorrow" }] },
    { role: "model", parts: [{ functionCall: { name: "list_services", args: {} } }, { functionCall: { name: "get_opening_hours", args: { a: 1 } } }] },
    { role: "user", parts: [{ functionResponse: { name: "get_opening_hours", response: { open: "9-5" } } }, { functionResponse: { name: "list_services", response: { services: [] } } }] },
  ],
  tools: [{ functionDeclarations: [{ name: "list_services", description: "d", parameters: { type: "object", properties: {} } }] }],
  generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
};

describe("OpenAI translation", () => {
  const body = toOpenAiRequest(request, "gpt-4.1-mini", false) as any;
  it("maps system prompt, tools and limits", () => {
    expect(body.messages[0]).toEqual({ role: "system", content: "You are a clinic assistant." });
    expect(body.tools[0].function.name).toBe("list_services");
    expect(body.temperature).toBe(0.3);
    expect(body.max_completion_tokens).toBe(1024);
  });
  it("pairs each tool result with its call by name, even when returned out of order", () => {
    const assistant = body.messages.find((m: any) => m.role === "assistant");
    const idOf = (name: string) => assistant.tool_calls.find((c: any) => c.function.name === name).id;
    const results = body.messages.filter((m: any) => m.role === "tool");
    expect(results.map((r: any) => r.tool_call_id)).toEqual([idOf("get_opening_hours"), idOf("list_services")]);
  });
  it("omits temperature for reasoning models", () => {
    expect((toOpenAiRequest(request, "gpt-5", false) as any).temperature).toBeUndefined();
  });
});

describe("Anthropic translation", () => {
  const body = toAnthropicRequest(request, "claude-sonnet-5-5", true) as any;
  it("maps system prompt, tools and limits", () => {
    expect(body.system).toBe("You are a clinic assistant.");
    expect(body.tools[0].input_schema).toEqual({ type: "object", properties: {} });
    expect(body.max_tokens).toBe(1024);
    expect(body.stream).toBe(true);
  });
  it("sends tool_use blocks and matching tool_result blocks", () => {
    const uses = body.messages[1].content.filter((b: any) => b.type === "tool_use");
    const results = body.messages[2].content;
    expect(results.every((b: any) => b.type === "tool_result")).toBe(true);
    expect(results.map((b: any) => b.tool_use_id)).toEqual([uses[1].id, uses[0].id]);
  });
});

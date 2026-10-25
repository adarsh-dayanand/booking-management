import type { GeminiContent } from "./gemini";

/**
 * Conversations are kept in Gemini's shape, where a tool result is matched to its call by name and order. OpenAI and
 * Anthropic match by id instead, so give every function part one: the id the provider issued (kept on the part as
 * `toolCallId`) or a stable one derived from its position, then pair each result with the call it answers.
 * Returns, per content, the ids of its function parts in order.
 */
export function toolIdsFor(contents: GeminiContent[]): string[][] {
  let pending: { id: string; name: string }[] = [];
  return contents.map((content, c) => {
    const ids: string[] = [];
    const calls: { id: string; name: string }[] = [];
    content.parts.forEach((part, p) => {
      if (part.functionCall) {
        const id = typeof part.toolCallId === "string" ? part.toolCallId : `call_${c}_${p}`;
        ids.push(id);
        calls.push({ id, name: part.functionCall.name });
      } else if (part.functionResponse) {
        const i = pending.findIndex((call) => call.name === part.functionResponse!.name);
        const match = pending.splice(i >= 0 ? i : 0, 1)[0];
        ids.push(match?.id ?? `call_${c}_${p}`);
      }
    });
    if (calls.length) pending = calls;
    return ids;
  });
}

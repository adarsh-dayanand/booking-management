import http from "http";
import type { AddressInfo } from "net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let server: http.Server;
let generateStream: typeof import("../chat/gemini").generateStream;

const frame = (parts: object[], finishReason?: string) =>
  `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason }] })}\r\n\r\n`;

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const frames = [
      frame([{ text: "Hel" }]),
      frame([{ text: "lo", thought: false }]),
      frame([{ text: "(private reasoning)", thought: true }]),
      frame([{ functionCall: { name: "list_services", args: {} }, thoughtSignature: "sig-1" }], "STOP"),
    ].join("");
    // dribble out in awkward 7-byte pieces so frames are split mid-event and mid-JSON
    let i = 0;
    const timer = setInterval(() => {
      if (i >= frames.length) {
        clearInterval(timer);
        res.end();
        return;
      }
      res.write(frames.slice(i, i + 7));
      i += 7;
    }, 1);
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  process.env.GEMINI_API_KEY = "test-key";
  process.env.GEMINI_BASE_URL = `http://localhost:${(server.address() as AddressInfo).port}/v1beta/models`;
  ({ generateStream } = await import("../chat/gemini"));
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("generateStream", () => {
  it("emits visible text fragments in order, hides thoughts, and keeps function calls + signatures intact", async () => {
    const seen: string[] = [];
    const response = await generateStream({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }, (t) => seen.push(t));
    expect(seen).toEqual(["Hel", "lo"]);
    const parts = response.candidates![0].content!.parts;
    expect(parts.filter((p) => p.functionCall)).toEqual([{ functionCall: { name: "list_services", args: {} }, thoughtSignature: "sig-1" }]);
    expect(response.candidates![0].finishReason).toBe("STOP");
  });
});

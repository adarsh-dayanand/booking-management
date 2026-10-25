/** Calls `onData` with the joined `data:` payload of every server-sent event in a streamed response body. */
export async function readSse(body: ReadableStream<Uint8Array> | null, onData: (data: string) => void): Promise<void> {
  const handle = (raw: string) => {
    const data = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");
    if (data && data !== "[DONE]") onData(data);
  };
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary: RegExpMatchArray | null;
    while ((boundary = buffer.match(/\r?\n\r?\n/))) {
      handle(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index! + boundary[0].length);
    }
  }
  if (buffer.trim()) handle(buffer);
}

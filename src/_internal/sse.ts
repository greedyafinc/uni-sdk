// Minimal SSE parser. Yields one message per `\n\n`-separated frame.
// Handles `event:`, `data:`, and `id:` fields; ignores comments and unknown fields.
// Multi-line `data:` is joined with `\n` per the SSE spec.

export interface SSEMessage {
  event?: string;
  data: string;
  id?: string;
}

export async function* parseSSE(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEMessage, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        const tail = flush(buffer);
        if (tail) yield tail;
        return;
      }
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line. Support both \n\n and \r\n\r\n.
      let sep = findFrameBoundary(buffer);
      while (sep !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + (buffer[sep] === "\r" ? 4 : 2));
        const msg = parseFrame(frame);
        if (msg) yield msg;
        sep = findFrameBoundary(buffer);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }
}

function findFrameBoundary(buf: string): number {
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function flush(buf: string): SSEMessage | null {
  if (!buf.trim()) return null;
  return parseFrame(buf);
}

function parseFrame(raw: string): SSEMessage | null {
  const lines = raw.split(/\r?\n/);
  let event: string | undefined;
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id") id = value;
  }

  if (dataLines.length === 0) return null;
  const msg: SSEMessage = { data: dataLines.join("\n") };
  if (event !== undefined) msg.event = event;
  if (id !== undefined) msg.id = id;
  return msg;
}

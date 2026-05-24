import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseSSE } from "../../src/core/_internal/sse";
import type { TokenSet } from "../../src/core/_internal/tokens";
import { InMemoryKeychain } from "../../src/node/_internal/keychain";
import { UnifiedAI, UnifiedAIError } from "../../src/node/index";

const CLIENT = "app_test";
const USER = "user_test";
const ACCESS_TOKEN = "access_test";

interface FakeStreamApi {
  baseUrl: string;
  stop: () => Promise<void>;
  // Each frame is "event:...\ndata:...\n\n" or "data: ...\n\n".
  setFrames: (frames: string[], opts?: { delayMs?: number; status?: number }) => void;
  requestCount: () => number;
  aborted: () => number;
}

async function startFakeStreamApi(): Promise<FakeStreamApi> {
  let frames: string[] = [];
  let delayMs = 5;
  let status = 200;
  let reqs = 0;
  let aborts = 0;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      reqs++;
      // Read body so the client's fetch doesn't stall on a half-closed request.
      await req.text();
      if (status !== 200) {
        return new Response(JSON.stringify({ error: "boom" }), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      const encoder = new TextEncoder();
      const list = frames.slice();
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          try {
            for (const f of list) {
              if (req.signal.aborted) throw new Error("aborted");
              controller.enqueue(encoder.encode(f));
              if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
            }
            controller.close();
          } catch {
            aborts++;
            try {
              controller.close();
            } catch {}
          }
        },
        cancel() {
          aborts++;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      await server.stop(true);
    },
    setFrames: (f, opts) => {
      frames = f;
      delayMs = opts?.delayMs ?? 5;
      status = opts?.status ?? 200;
    },
    requestCount: () => reqs,
    aborted: () => aborts,
  };
}

function makeSdk(api: FakeStreamApi, keychain: InMemoryKeychain): UnifiedAI {
  return new UnifiedAI({
    appId: CLIENT,
    apiUrl: api.baseUrl,
    keychain,
    env: { read: () => ({ handoffPort: undefined, clientId: undefined }) },
    discovery: { read: async () => null },
    openUrl: async () => {},
  });
}

async function seedTokens(keychain: InMemoryKeychain): Promise<void> {
  const tokens: TokenSet = {
    access_token: ACCESS_TOKEN,
    refresh_token: "refresh_test",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user_id: USER,
    client_id: CLIENT,
  };
  await keychain.set(CLIENT, tokens);
}

describe("parseSSE", () => {
  test("parses multi-frame stream with event + data fields", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('event: a\ndata: {"v":1}\n\n'));
        controller.enqueue(enc.encode('data: {"v":2}\n\n'));
        controller.close();
      },
    });
    const out: Array<{ event?: string; data: string }> = [];
    for await (const m of parseSSE(stream)) out.push(m);
    expect(out).toEqual([{ event: "a", data: '{"v":1}' }, { data: '{"v":2}' }]);
  });

  test("buffers across chunk boundaries", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("data: hel"));
        controller.enqueue(enc.encode("lo\n\ndata: world\n\n"));
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const m of parseSSE(stream)) out.push(m.data);
    expect(out).toEqual(["hello", "world"]);
  });
});

describe("LLM streaming", () => {
  let api: FakeStreamApi;
  let keychain: InMemoryKeychain;
  let sdk: UnifiedAI;

  beforeEach(async () => {
    api = await startFakeStreamApi();
    keychain = new InMemoryKeychain();
    await seedTokens(keychain);
    sdk = makeSdk(api, keychain);
    await sdk.bootstrap();
  });

  afterEach(async () => {
    await api.stop();
  });

  test("chat.completions.create({stream:true}) yields chunks and stops on [DONE]", async () => {
    api.setFrames([
      `data: ${JSON.stringify({
        id: "x",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [{ index: 0, delta: { content: "hel" }, finish_reason: null }],
      })}\n\n`,
      `data: ${JSON.stringify({
        id: "x",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }],
      })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    const stream = sdk.chat.completions.create({
      model: "auto",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const chunks: string[] = [];
    for await (const c of stream) {
      const piece = c.choices[0]?.delta.content;
      if (piece) chunks.push(piece);
    }
    expect(chunks.join("")).toBe("hello");
  });

  test("responses.create({stream:true}) yields typed events", async () => {
    api.setFrames([
      `event: response.created\ndata: ${JSON.stringify({ response: { id: "r1" } })}\n\n`,
      `event: response.output_text.delta\ndata: ${JSON.stringify({
        output_index: 0,
        content_index: 0,
        delta: "yo",
      })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({
        response: {
          id: "r1",
          object: "response",
          created_at: 1,
          model: "m",
          output: [],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          status: "completed",
        },
      })}\n\n`,
    ]);
    const stream = sdk.responses.create({ model: "auto", input: "hi", stream: true });
    const types: string[] = [];
    for await (const ev of stream) types.push(ev.type);
    expect(types).toEqual(["response.created", "response.output_text.delta", "response.completed"]);
  });

  test("messages.create({stream:true}) yields anthropic events", async () => {
    api.setFrames([
      `event: message_start\ndata: ${JSON.stringify({
        message: {
          id: "m1",
          type: "message",
          role: "assistant",
          model: "m",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        index: 0,
        delta: { type: "text_delta", text: "hi" },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({})}\n\n`,
    ]);
    const stream = sdk.messages.create({
      model: "auto",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    const types: string[] = [];
    for await (const ev of stream) types.push(ev.type);
    expect(types).toEqual(["message_start", "content_block_delta", "message_stop"]);
  });

  test(".abort() stops the stream mid-flight", async () => {
    api.setFrames(
      Array.from(
        { length: 50 },
        (_, i) =>
          `data: ${JSON.stringify({
            id: "x",
            object: "chat.completion.chunk",
            created: 1,
            model: "m",
            choices: [{ index: 0, delta: { content: `${i}` }, finish_reason: null }],
          })}\n\n`,
      ),
      { delayMs: 20 },
    );
    const stream = sdk.chat.completions.create({
      model: "auto",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    let count = 0;
    try {
      for await (const _ of stream) {
        count++;
        if (count === 2) stream.abort();
      }
    } catch {
      // Abort surfaces as an AbortError on the iterator; that's fine.
    }
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThan(50);
  });

  test("non-2xx surfaces UnifiedAIError before iteration", async () => {
    api.setFrames([], { status: 400 });
    let caught: unknown;
    try {
      const stream = sdk.chat.completions.create({
        model: "auto",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      });
      for await (const _ of stream) {
        // unreachable
      }
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnifiedAIError);
    expect((caught as UnifiedAIError).status).toBe(400);
  });
});

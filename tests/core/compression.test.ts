import { describe, expect, test } from "bun:test";
import { UnifiedAI } from "../../src/core/client";

// UNI-100: the `compression` request param. Per-request value wins over the
// client-level default via `??` (so an explicit `false` beats a default of
// `true`); when neither side sets it, the key must not appear in the wire
// body at all — JSON.stringify drops `undefined` values, and these tests
// parse the actual serialized body to prove it.

const chatResponse = {
  id: "cmpl-1",
  object: "chat.completion",
  created: 1700000000,
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

const messagesResponse = {
  id: "msg-1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "hi" }],
  model: "m",
  stop_reason: "end_turn",
  usage: { input_tokens: 1, output_tokens: 1 },
};

const responsesResponse = {
  id: "resp-1",
  object: "response",
  created_at: 1700000000,
  model: "m",
  output: [],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  status: "completed",
};

/** Fake fetch that JSON.parses the serialized request body for assertions. */
function jsonCapture(responseBody: unknown) {
  let captured: Record<string, unknown> | undefined;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(String(init.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    body: () => {
      if (!captured) throw new Error("fetch was never called");
      return captured;
    },
  };
}

interface Surface {
  name: string;
  response: unknown;
  call: (sdk: UnifiedAI, params: { compression?: boolean }) => Promise<unknown>;
}

const surfaces: Surface[] = [
  {
    name: "chat.completions.create",
    response: chatResponse,
    call: (sdk, p) =>
      sdk.chat.completions.create({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        ...p,
      }),
  },
  {
    name: "messages.create",
    response: messagesResponse,
    call: (sdk, p) =>
      sdk.messages.create({
        model: "m",
        max_tokens: 8,
        messages: [{ role: "user", content: "hi" }],
        ...p,
      }),
  },
  {
    name: "responses.create",
    response: responsesResponse,
    call: (sdk, p) => sdk.responses.create({ model: "m", input: "hi", ...p }),
  },
];

function makeSdk(fetchImpl: typeof fetch, compression?: boolean): UnifiedAI {
  return new UnifiedAI({
    apiUrl: "https://example.test",
    token: "t",
    fetch: fetchImpl,
    ...(compression !== undefined ? { compression } : {}),
  });
}

for (const surface of surfaces) {
  describe(`compression param — ${surface.name}`, () => {
    test("client default true serializes compression:true", async () => {
      const { fetchImpl, body } = jsonCapture(surface.response);
      await surface.call(makeSdk(fetchImpl, true), {});
      expect(body().compression).toBe(true);
    });

    test("per-request true with no client default serializes compression:true", async () => {
      const { fetchImpl, body } = jsonCapture(surface.response);
      await surface.call(makeSdk(fetchImpl), { compression: true });
      expect(body().compression).toBe(true);
    });

    test("per-request false overrides a client default of true", async () => {
      const { fetchImpl, body } = jsonCapture(surface.response);
      await surface.call(makeSdk(fetchImpl, true), { compression: false });
      expect(body().compression).toBe(false);
    });

    test("absent on both sides leaves the key out of the wire body", async () => {
      const { fetchImpl, body } = jsonCapture(surface.response);
      await surface.call(makeSdk(fetchImpl), {});
      expect(Object.hasOwn(body(), "compression")).toBe(false);
    });
  });
}

describe("compression param — streaming", () => {
  test("chat.completions createStream body carries the flag", async () => {
    let captured: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      // Capture the serialized body before handing back a canned SSE stream.
      captured = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    const sdk = makeSdk(fetchImpl, true);
    const stream = sdk.chat.completions.create({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    });
    for await (const _chunk of stream) {
      // Drain — the request only fires once iteration starts.
    }
    expect(captured).toBeDefined();
    expect(captured?.compression).toBe(true);
    expect(captured?.stream).toBe(true);
  });
});

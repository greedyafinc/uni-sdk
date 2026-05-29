import { describe, expect, test } from "bun:test";
import { UnifiedAI } from "../../src/core/client";

describe("embeddings.createBatch", () => {
  test("chunks an over-limit input array and concatenates results in order", async () => {
    const received: number[][] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      const inputs: string[] = body.input;
      // Echo a vector per input. Provider returns 0-based local indices.
      const data = inputs.map((s, i) => ({
        object: "embedding",
        embedding: [s.length],
        index: i,
      }));
      received.push(inputs.map((s) => s.length));
      return new Response(
        JSON.stringify({
          object: "list",
          data,
          model: "test-model",
          usage: { prompt_tokens: inputs.length, total_tokens: inputs.length },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
    });

    const inputs = Array.from({ length: 250 }, (_, i) => "x".repeat((i % 5) + 1));
    const res = await sdk.embeddings.createBatch(
      { model: "test-model", input: inputs },
      { batchSize: 100 },
    );

    expect(res.data).toHaveLength(250);
    // Indices must be globally re-based across chunks.
    expect(res.data[0]?.index).toBe(0);
    expect(res.data[99]?.index).toBe(99);
    expect(res.data[100]?.index).toBe(100);
    expect(res.data[249]?.index).toBe(249);
    expect(res.usage.prompt_tokens).toBe(250);
    expect(received).toHaveLength(3); // 100 + 100 + 50
    expect(received[2]).toHaveLength(50);
  });

  test("single-chunk input (below batchSize) issues exactly one request", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          object: "list",
          data: [{ object: "embedding", embedding: [1], index: 0 }],
          model: "m",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
    });
    const res = await sdk.embeddings.createBatch({ model: "m", input: ["only-one"] });
    expect(res.data).toHaveLength(1);
    expect(calls).toBe(1);
  });

  test("aborting the signal during a batch stops further chunks", async () => {
    let calls = 0;
    const ctrl = new AbortController();
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls += 1;
      // Stretch the first chunk so the scheduled abort below fires while
      // it's still in flight — by the time chunk 2 is about to send, the
      // signal is already aborted and the SDK propagates it. Without the
      // stretch, `setTimeout` is a macrotask that loses to the microtask
      // queue draining into chunk 2's send.
      if (calls === 1) {
        setTimeout(() => ctrl.abort(), 5);
        await new Promise((r) => setTimeout(r, 25));
      }
      if ((init.signal as AbortSignal | undefined)?.aborted) {
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      return new Response(
        JSON.stringify({
          object: "list",
          data: [{ object: "embedding", embedding: [1], index: 0 }],
          model: "m",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
    });
    const inputs = ["a", "b", "c", "d"];
    let caught: unknown;
    try {
      await sdk.embeddings.createBatch(
        { model: "m", input: inputs },
        { batchSize: 1, signal: ctrl.signal },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    // We must not have fired all 4 chunk requests after abort.
    expect(calls).toBeLessThan(4);
  });

  test("throws on empty input", async () => {
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: (async () => new Response("{}")) as unknown as typeof fetch,
    });
    await expect(sdk.embeddings.createBatch({ model: "m", input: [] })).rejects.toThrow();
  });
});

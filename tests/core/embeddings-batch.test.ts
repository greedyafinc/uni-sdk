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

  test("throws on empty input", async () => {
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: (async () => new Response("{}")) as unknown as typeof fetch,
    });
    await expect(sdk.embeddings.createBatch({ model: "m", input: [] })).rejects.toThrow();
  });
});

import { describe, expect, test } from "bun:test";
import { LruCache, cacheKey } from "../../src/core/_internal/cache";
import { UnifiedAI } from "../../src/core/client";

describe("LruCache", () => {
  test("stores and returns values until TTL elapses", () => {
    const c = new LruCache({ maxEntries: 4, ttlMs: 1000 });
    c.set("k", { v: 1 });
    expect(c.get("k")).toEqual({ v: 1 });
  });

  test("evicts the least-recently-used entry past maxEntries", () => {
    const c = new LruCache({ maxEntries: 2, ttlMs: 60_000 });
    c.set("a", 1);
    c.set("b", 2);
    c.get("a"); // bump a to MRU
    c.set("c", 3); // should evict b
    expect(c.get("a")).toBe(1);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("c")).toBe(3);
  });

  test("expired entries are dropped on read", async () => {
    const c = new LruCache({ maxEntries: 4, ttlMs: 5 });
    c.set("k", 99);
    await new Promise((r) => setTimeout(r, 15));
    expect(c.get("k")).toBeUndefined();
    expect(c.size).toBe(0);
  });
});

describe("cacheKey", () => {
  test("identical key for identical content regardless of key order", () => {
    const a = cacheKey("POST", "/x", { a: 1, b: 2 });
    const b = cacheKey("POST", "/x", { b: 2, a: 1 });
    expect(a).toBe(b);
  });

  test("different method or path yields a different key", () => {
    expect(cacheKey("GET", "/x", {})).not.toBe(cacheKey("POST", "/x", {}));
    expect(cacheKey("GET", "/x", {})).not.toBe(cacheKey("GET", "/y", {}));
  });

  test("different query params yield different keys", () => {
    expect(cacheKey("GET", "/x", {}, { limit: 10 })).not.toBe(
      cacheKey("GET", "/x", {}, { limit: 100 }),
    );
  });
});

describe("LruCache isolation", () => {
  test("caller mutation of a returned value does not corrupt subsequent hits", () => {
    const c = new LruCache({ maxEntries: 4, ttlMs: 60_000 });
    c.set("k", { data: [1, 2, 3] });
    const r1 = c.get("k") as { data: number[] };
    r1.data.pop();
    const r2 = c.get("k") as { data: number[] };
    expect(r2.data).toEqual([1, 2, 3]);
  });
});

describe("resource-level cache opt-in", () => {
  test("embeddings.create(cache:true) reuses cached body across identical params", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(
        JSON.stringify({
          object: "list",
          data: [{ object: "embedding", embedding: [0.1, 0.2], index: 0 }],
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
      cache: { ttlMs: 60_000 },
    });
    const a = await sdk.embeddings.create({ model: "m", input: "hi" }, { cache: true });
    const b = await sdk.embeddings.create({ model: "m", input: "hi" }, { cache: true });
    expect(a).toEqual(b);
    expect(calls).toBe(1);
    // Different input → miss.
    await sdk.embeddings.create({ model: "m", input: "bye" }, { cache: true });
    expect(calls).toBe(2);
  });

  test("images.generate(cache:true) reuses cached body across identical params", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ created: 0, data: [{ url: "https://x/img.png" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
      cache: { ttlMs: 60_000 },
    });
    await sdk.images.generate({ prompt: "a cat" }, { cache: true });
    await sdk.images.generate({ prompt: "a cat" }, { cache: true });
    expect(calls).toBe(1);
  });

  test("embeddings.create is treated as idempotent for retry (POST + 5xx retried)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("{}", {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          object: "list",
          data: [{ object: "embedding", embedding: [0.1], index: 0 }],
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
      retry: { initialDelayMs: 1, maxDelayMs: 1 },
    });
    const res = await sdk.embeddings.create({ model: "m", input: "x" });
    expect(res.data).toHaveLength(1);
    expect(calls).toBe(2);
  });
});

describe("UnifiedAI cache integration", () => {
  test("cache hit short-circuits the HTTP call", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ v: calls }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
      cache: { maxEntries: 16, ttlMs: 60_000 },
    });
    const r1 = await sdk.request<{ v: number }>("/x", {
      method: "POST",
      body: { same: true },
      cache: true,
    });
    const r2 = await sdk.request<{ v: number }>("/x", {
      method: "POST",
      body: { same: true },
      cache: true,
    });
    expect(r1).toEqual(r2);
    expect(calls).toBe(1);
  });

  test("cache miss preserves normal behavior", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ v: calls }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
      cache: { ttlMs: 60_000 },
    });
    await sdk.request<{ v: number }>("/x", {
      method: "POST",
      body: { a: 1 },
      cache: true,
    });
    await sdk.request<{ v: number }>("/x", {
      method: "POST",
      body: { a: 2 }, // different body → cache miss
      cache: true,
    });
    expect(calls).toBe(2);
  });

  test("cache is no-op when client has no cache configured", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ v: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
    });
    await sdk.request("/x", { cache: true });
    await sdk.request("/x", { cache: true });
    expect(calls).toBe(2);
  });
});

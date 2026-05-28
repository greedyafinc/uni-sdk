import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RETRY,
  computeBackoff,
  isIdempotent,
  isNetworkErrorRetryable,
  isRetryableStatus,
  nextDelay,
  parseRetryAfterHeader,
  resolveRetryConfig,
} from "../../src/core/_internal/retry";
import { UnifiedAI } from "../../src/core/client";
import { RateLimitError, UnifiedAIAuthError, UnifiedAIError } from "../../src/core/errors";

describe("retry classifier", () => {
  test("retries 408, 429, and all 5xx; not 4xx else", () => {
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });

  test("isIdempotent honors HTTP method default and per-call override", () => {
    expect(isIdempotent("GET", undefined)).toBe(true);
    expect(isIdempotent("DELETE", undefined)).toBe(true);
    expect(isIdempotent("POST", undefined)).toBe(false);
    expect(isIdempotent("POST", true)).toBe(true);
    expect(isIdempotent("GET", false)).toBe(false);
  });

  test("isNetworkErrorRetryable skips AbortError and typed SDK errors but accepts Node fetch errors", () => {
    expect(isNetworkErrorRetryable(new TypeError("fetch failed"))).toBe(true);
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isNetworkErrorRetryable(abort)).toBe(false);
    expect(isNetworkErrorRetryable(new UnifiedAIError("server_error", "x", 500, undefined))).toBe(
      false,
    );
    // Node/undici tag connection blips with .code (ECONNRESET / ETIMEDOUT /
    // UND_ERR_SOCKET). Those are the *target* of retry, not exclusions.
    const econnreset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    expect(isNetworkErrorRetryable(econnreset)).toBe(true);
    const undici = Object.assign(new Error("socket error"), {
      name: "FetchError",
      code: "UND_ERR_SOCKET",
    });
    expect(isNetworkErrorRetryable(undici)).toBe(true);
  });

  test("parseRetryAfterHeader handles numeric seconds", () => {
    const res = new Response("", { headers: { "retry-after": "2" } });
    expect(parseRetryAfterHeader(res)).toBe(2000);
  });

  test("computeBackoff respects the per-attempt cap", () => {
    const cfg = { ...DEFAULT_RETRY, initialDelayMs: 100, maxDelayMs: 1000 };
    // With rng() = 1, expo cap at attempt 0 is 100; attempt 5 hits maxDelay.
    expect(computeBackoff(0, cfg, () => 0.99)).toBeLessThan(100);
    expect(computeBackoff(5, cfg, () => 0.99)).toBeLessThan(1000);
  });

  test("nextDelay prefers Retry-After but caps it at maxDelayMs", () => {
    const cfg = { ...DEFAULT_RETRY, maxDelayMs: 2000 };
    const res = new Response("", { status: 429, headers: { "retry-after": "1" } });
    expect(nextDelay(0, cfg, res, () => 0)).toBe(1000);
    const big = new Response("", { status: 429, headers: { "retry-after": "999999" } });
    expect(nextDelay(0, cfg, big, () => 0)).toBe(2000);
  });

  test("resolveRetryConfig", () => {
    expect(resolveRetryConfig(false)).toBeUndefined();
    expect(resolveRetryConfig(undefined)).toEqual(DEFAULT_RETRY);
    const partial = resolveRetryConfig({ maxRetries: 7 });
    expect(partial?.maxRetries).toBe(7);
    expect(partial?.maxElapsedMs).toBe(DEFAULT_RETRY.maxElapsedMs);
  });
});

describe("UnifiedAI retry integration", () => {
  test("429 with Retry-After retries and succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "rate_limited" }), {
          status: 429,
          headers: { "retry-after": "0", "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const events: number[] = [];
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
      retry: { initialDelayMs: 1, maxDelayMs: 1 },
      onRetry: (e) => events.push(e.status ?? -1),
    });
    const res = await sdk.request<{ ok: boolean }>("/x");
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
    expect(events).toEqual([429]);
  });

  test("network error retried up to max, then surfaces typed error", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new TypeError("network blip");
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
      retry: { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 1 },
    });
    let caught: unknown;
    try {
      await sdk.request("/x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect(calls).toBe(3);
  });

  test("POST without idempotent=true does NOT retry on network error", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new TypeError("network blip");
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
      retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 1 },
    });
    await expect(sdk.request("/x", { method: "POST", body: {} })).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(1);
  });

  test("POST with idempotent=true retries on network error", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("network blip");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
      retry: { maxRetries: 5, initialDelayMs: 1, maxDelayMs: 1 },
    });
    const res = await sdk.request<{ ok: boolean }>("/x", {
      method: "POST",
      body: {},
      idempotent: true,
    });
    expect(res.ok).toBe(true);
    expect(calls).toBe(3);
  });

  test("retry: false on a call disables retry even if client has it on", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
      retry: { maxRetries: 5, initialDelayMs: 1, maxDelayMs: 1 },
    });
    await expect(sdk.request("/x", { retry: false })).rejects.toBeInstanceOf(UnifiedAIError);
    expect(calls).toBe(1);
  });

  test("non-idempotent POST does NOT retry 5xx (might double-execute)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "gateway" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
      retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 1 },
    });
    await expect(sdk.request("/x", { method: "POST", body: {} })).rejects.toBeInstanceOf(
      UnifiedAIError,
    );
    expect(calls).toBe(1);
  });

  test("non-idempotent POST DOES retry 429 (server told us to back off)", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "rate_limited" }), {
          status: 429,
          headers: { "retry-after": "0", "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
      retry: { initialDelayMs: 1, maxDelayMs: 1 },
    });
    const res = await sdk.request<{ ok: boolean }>("/x", { method: "POST", body: {} });
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
  });

  test("abort during retry backoff surfaces AbortError, not the prior network error", async () => {
    let calls = 0;
    const ctrl = new AbortController();
    const fetchImpl = (async () => {
      calls += 1;
      throw new TypeError("network blip");
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
      retry: { maxRetries: 3, initialDelayMs: 50, maxDelayMs: 50 },
    });
    setTimeout(() => ctrl.abort(), 10);
    let caught: unknown;
    try {
      await sdk.request("/x", { method: "POST", idempotent: true, signal: ctrl.signal });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error)?.name).toBe("AbortError");
    expect(calls).toBe(1);
  });

  test("plain Error from host token provider on refresh does not re-trigger retry", async () => {
    let calls = 0;
    let refreshCalls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "unauth" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: () => {
        refreshCalls += 1;
        if (refreshCalls > 1) throw new Error("network down"); // plain Error
        return "stale";
      },
      fetch: fetchImpl,
      retry: { maxRetries: 3, initialDelayMs: 1, maxDelayMs: 1 },
    });
    await expect(sdk.request("/x")).rejects.toBeInstanceOf(UnifiedAIAuthError);
    // 1 initial send (401), 1 refresh that throws → terminal, NO retry.
    expect(calls).toBe(1);
  });

  test("RateLimitError finally surfaces when retries are exhausted", async () => {
    const fetchImpl = (async () => {
      return new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "retry-after": "0", "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
      retry: { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 1 },
    });
    await expect(sdk.request("/x")).rejects.toBeInstanceOf(RateLimitError);
  });
});

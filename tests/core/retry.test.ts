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

  test("parseRetryAfterHeader handles HTTP-date form", () => {
    const future = new Date(Date.now() + 2500).toUTCString();
    const res = new Response("", { headers: { "retry-after": future } });
    const v = parseRetryAfterHeader(res);
    // Allow a 1s tolerance for clock skew between Date.now() calls.
    expect(v).toBeGreaterThan(1000);
    expect(v).toBeLessThan(3500);
  });

  test("parseRetryAfterHeader returns undefined when missing or garbage", () => {
    expect(parseRetryAfterHeader(new Response(""))).toBeUndefined();
    expect(
      parseRetryAfterHeader(new Response("", { headers: { "retry-after": "not-a-date" } })),
    ).toBeUndefined();
  });

  test("parseRetryAfterHeader treats whitespace-only header as missing (not 0)", () => {
    // Without the guard, Number('   '.trim()) === Number('') === 0 would
    // collapse the backoff to 0ms and produce a tight retry burst.
    expect(
      parseRetryAfterHeader(new Response("", { headers: { "retry-after": "   " } })),
    ).toBeUndefined();
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
      // Abort while attempt 1 is in flight: the backoff check must surface
      // the cancellation, not the TypeError below. Aborting here (instead of
      // a timer) is deterministic — full-jitter backoff can draw waits short
      // enough to slip extra attempts in before any scheduled abort fires.
      ctrl.abort();
      throw new TypeError("network blip");
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
      retry: { maxRetries: 3, initialDelayMs: 50, maxDelayMs: 50 },
    });
    let caught: unknown;
    try {
      await sdk.request("/x", { method: "POST", idempotent: true, signal: ctrl.signal });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error)?.name).toBe("AbortError");
    expect(calls).toBe(1);
  });

  test("maxElapsedMs caps the retry budget across attempts", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        // Retry-After pins every wait to exactly maxDelayMs (min(1000, 50)),
        // sidestepping jitter: unlucky near-zero draws otherwise let 10+
        // attempts through the 120ms budget on a fast machine, while a slow
        // runner can blow a wall-clock bound. With 50ms waits the loop can
        // only attempt at t≈0/50/100 before `elapsed + wait` exceeds the cap.
        headers: { "content-type": "application/json", "retry-after": "1" },
      });
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
      retry: {
        maxRetries: 20,
        initialDelayMs: 50,
        maxDelayMs: 50,
        maxElapsedMs: 120,
      },
    });
    await expect(sdk.request("/x")).rejects.toBeInstanceOf(UnifiedAIError);
    // Exited via the elapsed cap, far short of the 20 configured retries.
    // Slow runners only shrink the count (elapsed grows faster), never grow it.
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(calls).toBeLessThanOrEqual(3);
  });

  test("client-level AND per-call onRetry listeners both fire", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({}), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const clientEvents: number[] = [];
    const perCallEvents: number[] = [];
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
      retry: { initialDelayMs: 1, maxDelayMs: 1 },
      onRetry: (e) => clientEvents.push(e.status ?? -1),
    });
    await sdk.request("/x", { onRetry: (e) => perCallEvents.push(e.attempt) });
    expect(clientEvents).toEqual([503]);
    expect(perCallEvents).toEqual([1]);
  });

  test("a throwing onRetry listener does not break the retry loop", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("{}", {
          status: 503,
          headers: { "content-type": "application/json" },
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
      onRetry: () => {
        throw new Error("buggy listener");
      },
    });
    const res = await sdk.request<{ ok: boolean }>("/x");
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
  });

  test("requestBinary retries on 5xx for idempotent GET", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("err", {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
      retry: { initialDelayMs: 1, maxDelayMs: 1 },
    });
    const { bytes } = await sdk.requestBinary("/x");
    expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3]));
    expect(calls).toBe(2);
  });

  test("stream retries on 5xx for idempotent GET", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("err", {
          status: 502,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("data: hello\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
      retry: { initialDelayMs: 1, maxDelayMs: 1 },
    });
    const body = await sdk.stream("/x");
    expect(body).toBeDefined();
    expect(calls).toBe(2);
    // Drain so the test doesn't leak an open reader.
    const reader = body.getReader();
    while (!(await reader.read()).done) {}
  });

  test("successful 401 refresh in attempt 1 propagates fresh token to attempt 2 (5xx)", async () => {
    // This exercises the `currentToken` mutable-across-attempts fix: a 401
    // inside attempt 1 triggers refresh; the second send in attempt 1 returns
    // a retryable 5xx; attempt 2 must reuse the REFRESHED token, not the
    // original. Without the fix, attempt 2 sends the stale token → another
    // 401 → forces a second refresh cycle.
    const tokens: string[] = [];
    let tokenSeq = 0;
    let calls = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      calls += 1;
      const auth = (init.headers as Record<string, string>).authorization ?? "";
      tokens.push(auth);
      if (calls === 1) {
        return new Response("{}", {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      if (calls === 2) {
        return new Response("{}", {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: () => {
        tokenSeq += 1;
        return `t-${tokenSeq}`;
      },
      fetch: fetchImpl,
      retry: { initialDelayMs: 1, maxDelayMs: 1 },
    });
    const res = await sdk.request<{ ok: boolean }>("/x");
    expect(res.ok).toBe(true);
    expect(calls).toBe(3);
    // Token sequence: original → refreshed (after 401) → refreshed reused
    // (no second 401 on attempt 2). Tokens captured at each send:
    //   tokens[0] = first call (original)
    //   tokens[1] = retry within attempt 1 (refreshed)
    //   tokens[2] = attempt 2 retry — MUST equal tokens[1]
    expect(tokens[2]).toBe(tokens[1]);
    expect(tokens[1]).not.toBe(tokens[0]);
  });

  test("abort during retry backoff preserves signal.reason on the surfaced AbortError", async () => {
    const ctrl = new AbortController();
    class DomainTimeoutError extends Error {
      constructor() {
        super("deadline exceeded");
        this.name = "DomainTimeoutError";
      }
    }
    const reason = new DomainTimeoutError();
    const fetchImpl = (async () => {
      // Abort in-flight with a typed reason (deterministic; see the
      // AbortError test above for why a timer-scheduled abort is racy).
      ctrl.abort(reason);
      throw new TypeError("network blip");
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      token: "t",
      fetch: fetchImpl,
      retry: { maxRetries: 3, initialDelayMs: 500, maxDelayMs: 500 },
    });
    let caught: unknown;
    try {
      await sdk.request("/x", { method: "POST", idempotent: true, signal: ctrl.signal });
    } catch (e) {
      caught = e;
    }
    expect((caught as Error)?.name).toBe("AbortError");
    expect((caught as { cause?: unknown })?.cause).toBe(reason);
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

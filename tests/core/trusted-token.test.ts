import { describe, expect, test } from "bun:test";
import { UnifiedAI, UnifiedAIAuthError, UnifiedError } from "../../src/index";
import type { SessionEvent } from "../../src/core/session";

// Exercises the browser-safe UnifiedAI directly from source. These tests
// stand alone — they do not require a build artifact.

describe("browser UnifiedAI (trusted-token mode)", () => {
  test("bootstrap is a no-op when token is supplied", async () => {
    const sdk = new UnifiedAI({ token: "abc" });
    await expect(sdk.bootstrap()).resolves.toBeUndefined();
  });

  test("bootstrap rejects with not_implemented when no token configured", async () => {
    const sdk = new UnifiedAI();
    await expect(sdk.bootstrap()).rejects.toBeInstanceOf(UnifiedError);
    await expect(sdk.bootstrap()).rejects.toMatchObject({ code: "not_implemented" });
  });

  test("identity throws when not in a subclass", () => {
    const sdk = new UnifiedAI({ token: "abc" });
    expect(() => sdk.identity()).toThrow(UnifiedError);
  });

  test("signOut is a no-op in trusted-token mode", async () => {
    const sdk = new UnifiedAI({ token: "abc" });
    await expect(sdk.signOut()).resolves.toBeUndefined();
  });

  test("token provider can be a string or async function", async () => {
    let calls = 0;
    const captured: Request[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured.push(new Request(input as string, init));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: async () => {
        calls++;
        return `dynamic-token-${calls}`;
      },
    });

    await sdk.usage.get();
    await sdk.usage.get();

    expect(calls).toBe(2);
    const auth1 = captured[0]?.headers.get("authorization");
    const auth2 = captured[1]?.headers.get("authorization");
    expect(auth1).toBe("Bearer dynamic-token-1");
    expect(auth2).toBe("Bearer dynamic-token-2");
  });

  test("empty token string omits the Authorization header", async () => {
    let captured: Request | undefined;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input as string, init);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: "",
    });

    await sdk.usage.get();
    expect(captured?.headers.has("authorization")).toBe(false);
  });

  test("appId stamps X-Unified-App on every request", async () => {
    let captured: Request | undefined;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input as string, init);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: "uapi_test",
      appId: "notes",
    });

    await sdk.usage.get();
    expect(captured?.headers.get("x-unified-app")).toBe("notes");
  });

  test("empty appId omits X-Unified-App", async () => {
    let captured: Request | undefined;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input as string, init);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: "uapi_test",
    });

    await sdk.usage.get();
    expect(captured?.headers.has("x-unified-app")).toBe(false);
  });

  test("single-flight: concurrent 401s share exactly one refresh", async () => {
    // The SDK calls the provider once per request to get the initial token
    // (cheap read, no coalescing), then ONCE per 401 burst for refresh
    // (single-flighted). So with N concurrent 401s we expect N + 1 total
    // calls. A regression that loses the single-flight gating would produce
    // N + N calls (one refresh per retry).
    const N = 5;
    let providerCalls = 0;
    let refreshCalls = 0;
    const STALE = "stale-token";
    const FRESH = "fresh-token";

    // Hold the refresh call until every concurrent request has observed
    // its 401. This is what proves coalescing: if the SDK kicked off N
    // refreshes instead of one, we'd see refreshCalls === N.
    let releaseRefresh: (value: string) => void = () => {};
    const refreshGate = new Promise<string>((resolve) => {
      releaseRefresh = resolve;
    });

    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
      if (auth.endsWith(STALE)) return new Response("", { status: 401 });
      if (auth.endsWith(FRESH))
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`unexpected auth header: ${auth}`);
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: () => {
        providerCalls++;
        // First N calls are the per-request initial reads; everything after
        // is a refresh attempt (which we'd like to be exactly 1).
        if (providerCalls <= N) return STALE;
        refreshCalls++;
        return refreshGate;
      },
    });

    const inflight = Promise.all(Array.from({ length: N }, () => sdk.usage.get()));

    // Let microtasks settle so every initial fetch has issued + seen its 401,
    // and the SDK has had a chance to kick off the refresh path.
    await new Promise((r) => setTimeout(r, 10));

    expect(providerCalls).toBe(N + 1); // N initial reads + 1 refresh start
    expect(refreshCalls).toBe(1);

    releaseRefresh(FRESH);
    await inflight;

    // No further provider calls happen after the burst clears.
    expect(providerCalls).toBe(N + 1);
    expect(refreshCalls).toBe(1);
  });

  test("failed trusted refresh marks the session expired and notifies observers", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ message: "nope" }), {
        status: 401,
      })) as unknown as typeof fetch;
    let calls = 0;
    const providerFailure = new Error("keychain locked");
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: async () => {
        calls++;
        if (calls === 1) return "stale-token";
        throw providerFailure; // refresh path fails terminally
      },
    });
    const events: SessionEvent[] = [];
    sdk.session.onChange((e) => events.push(e));
    expect(sdk.session.status).toBe("active");

    let thrown: unknown;
    try {
      await sdk.usage.get();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnifiedAIAuthError);
    expect((thrown as UnifiedAIAuthError).code).toBe("auth_refresh_failed");
    // The provider's original failure rides along as Error.cause.
    expect((thrown as Error).cause).toBe(providerFailure);
    // The host learns auth is dead: status flips and an expired event fires.
    expect(sdk.session.status).toBe("expired");
    expect(sdk.session.isAuthenticated()).toBe(false);
    expect(events.map((e) => e.type)).toContain("expired");
  });

  test("retry that still 401s after refresh marks the session expired", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ message: "still no" }), {
        status: 401,
      })) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: async () => "always-rejected-token",
    });
    const events: SessionEvent[] = [];
    sdk.session.onChange((e) => events.push(e));

    let thrown: unknown;
    try {
      await sdk.usage.get();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnifiedAIAuthError);
    expect((thrown as UnifiedAIAuthError).code).toBe("auth_retry_still_unauthorized");
    expect(sdk.session.status).toBe("expired");
    // The successful refresh emits `refreshed` before the retried request
    // fails again; the terminal state must still be a single `expired`.
    expect(events.filter((e) => e.type === "expired").length).toBe(1);
  });
});

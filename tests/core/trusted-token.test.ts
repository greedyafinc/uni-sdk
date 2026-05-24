import { describe, expect, test } from "bun:test";
import { UnifiedAI, UnifiedError } from "../../src/index";

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
    const fakeFetch: typeof fetch = async (input, init) => {
      captured.push(new Request(input as string, init));
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

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
    const auth1 = captured[0].headers.get("authorization");
    const auth2 = captured[1].headers.get("authorization");
    expect(auth1).toBe("Bearer dynamic-token-1");
    expect(auth2).toBe("Bearer dynamic-token-2");
  });

  test("empty token string omits the Authorization header", async () => {
    let captured: Request | undefined;
    const fakeFetch: typeof fetch = async (input, init) => {
      captured = new Request(input as string, init);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: "",
    });

    await sdk.usage.get();
    expect(captured?.headers.has("authorization")).toBe(false);
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

    const fakeFetch: typeof fetch = async (input, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
      if (auth.endsWith(STALE)) return new Response("", { status: 401 });
      if (auth.endsWith(FRESH))
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      throw new Error(`unexpected auth header: ${auth}`);
    };

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
});

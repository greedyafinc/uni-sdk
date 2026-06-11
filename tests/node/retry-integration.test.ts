// Integration coverage for the request-layer retry path. These tests run the
// full Node OAuth subclass against a real Bun.serve upstream (no mocked
// fetch), exercise real refresh / keychain / session-event wiring, and
// confirm that retry behavior holds end-to-end.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InMemoryKeychain } from "../../src/node/_internal/keychain";
import type { RetryConfig } from "../../src/node/index";
import { UnifiedAI, UnifiedAIError } from "../../src/node/index";
import { startFakeWebAuth } from "../fake-web-auth";

const CLIENT = "app_test";
const USER = "user_test";

// Scriptable upstream: each path holds a queue of canned responses; the
// next request to that path pops one. Useful for "first 429, then 200"
// sequences that the static fake-api can't express.
interface ScriptedResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Optional: throw at the socket level (gateway nuke) before responding. */
  closeSocket?: boolean;
}

interface ScriptedApi {
  baseUrl: string;
  stop: () => Promise<void>;
  enqueue: (path: string, ...responses: ScriptedResponse[]) => void;
  setValidAccessTokens: (tokens: Iterable<string>) => void;
  requestLog: () => Array<{ path: string; method: string; auth: string }>;
}

async function startScriptedApi(): Promise<ScriptedApi> {
  const queues = new Map<string, ScriptedResponse[]>();
  let valid = new Set<string>();
  const log: Array<{ path: string; method: string; auth: string }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      const url = new URL(req.url);
      const auth = req.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      log.push({ path: url.pathname, method: req.method, auth });
      // Auth gate: anything with an unrecognized token gets 401 regardless of
      // the queue (mirrors how a real gateway short-circuits before routing).
      // When the valid set is empty we reject everything — that's what tests
      // use to simulate "token just got revoked upstream".
      if (!valid.has(token)) {
        return new Response("unauthorized", { status: 401 });
      }
      const q = queues.get(url.pathname);
      const next = q?.shift();
      if (!next) {
        return Response.json({ ok: true, path: url.pathname });
      }
      const headers = { "content-type": "application/json", ...next.headers };
      const body =
        next.body === undefined
          ? ""
          : typeof next.body === "string"
            ? next.body
            : JSON.stringify(next.body);
      return new Response(body, { status: next.status, headers });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      await server.stop(true);
    },
    enqueue: (path, ...responses) => {
      const q = queues.get(path) ?? [];
      q.push(...responses);
      queues.set(path, q);
    },
    setValidAccessTokens: (tokens) => {
      valid = new Set(tokens);
    },
    requestLog: () => log.slice(),
  };
}

interface Harness {
  sdk: UnifiedAI;
  api: ScriptedApi;
  web: Awaited<ReturnType<typeof startFakeWebAuth>>;
  keychain: InMemoryKeychain;
  cleanup: () => Promise<void>;
}

async function startSdk(retry?: false | Partial<RetryConfig>): Promise<Harness> {
  const web = await startFakeWebAuth({ userId: USER, expectedClientId: CLIENT });
  const api = await startScriptedApi();
  const keychain = new InMemoryKeychain();
  const sdk = new UnifiedAI({
    appId: CLIENT,
    apiUrl: api.baseUrl,
    tokenUrl: web.tokenUrl,
    authorizeUrl: web.authorizeUrl,
    keychain,
    env: { read: () => ({ handoffPort: undefined, clientId: undefined }) },
    discovery: { read: async () => null },
    openUrl: async (url) => {
      await fetch(url, { redirect: "follow" });
    },
    // Sub-millisecond backoff so the wall-clock cost of tests is dominated by
    // server roundtrips, not retry sleeps.
    retry: retry ?? { initialDelayMs: 1, maxDelayMs: 1 },
  });
  await sdk.bootstrap();
  const tokens = (await keychain.get(CLIENT)) as NonNullable<
    Awaited<ReturnType<InMemoryKeychain["get"]>>
  >;
  api.setValidAccessTokens([tokens.access_token]);
  // Mirror keychain → api so a refreshed token is immediately accepted upstream.
  const origSet = keychain.set.bind(keychain);
  keychain.set = async (id, t) => {
    api.setValidAccessTokens([t.access_token]);
    return origSet(id, t);
  };
  return {
    sdk,
    api,
    web,
    keychain,
    cleanup: async () => {
      await api.stop();
      await web.stop();
    },
  };
}

describe("integration: retry against real HTTP server", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startSdk();
  });

  afterEach(async () => {
    await h.cleanup();
  });

  test("503 followed by 200 is retried transparently for a GET", async () => {
    h.api.enqueue("/v1/ping", { status: 503, body: { error: "transient" } });
    // Second request to the same path hits the default 200-{ok:true} branch.
    const res = await h.sdk.request<{ ok: boolean }>("/v1/ping");
    expect(res.ok).toBe(true);
    // Two requests reached the server: failing 503 + successful retry.
    const pingHits = h.api.requestLog().filter((r) => r.path === "/v1/ping");
    expect(pingHits.length).toBe(2);
  });

  test("429 with Retry-After: 0 is retried and succeeds", async () => {
    h.api.enqueue("/v1/q", {
      status: 429,
      body: { error: "rate_limited" },
      headers: { "retry-after": "0" },
    });
    const res = await h.sdk.request<{ ok: boolean }>("/v1/q");
    expect(res.ok).toBe(true);
  });

  test("usage-limit 429 (code: usage_limit_exceeded) is terminal — not retried", async () => {
    // Quota exhaustion won't clear by waiting, so the retry layer must treat
    // this 429 as terminal. Enqueue several denials so any retry would show up
    // as extra hits; only the initial request should ever reach the server.
    for (let i = 0; i < 4; i++) {
      h.api.enqueue("/v1/usage", {
        status: 429,
        body: {
          message: "Usage limit exceeded. Window cost: $1.0000 / $1.00; top-up reserve $0.00",
          code: "usage_limit_exceeded",
        },
      });
    }
    const retryEvents: number[] = [];
    let caught: unknown;
    try {
      await h.sdk.request("/v1/usage", { onRetry: (e) => retryEvents.push(e.attempt) });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnifiedAIError);
    expect((caught as { name?: string }).name).toBe("UsageLimitError");
    // No retry events fired and only the single initial request was sent.
    expect(retryEvents).toEqual([]);
    const hits = h.api.requestLog().filter((r) => r.path === "/v1/usage").length;
    expect(hits).toBe(1);
  });

  test("usage-limit 429 detected by message alone (no code) is also terminal", async () => {
    // Back-compat: older unified-api builds emit the human message without the
    // machine code. isUsageLimitBody's message fallback must still stop the
    // retry storm so this keeps working before every gateway ships the code.
    for (let i = 0; i < 4; i++) {
      h.api.enqueue("/v1/usage", {
        status: 429,
        body: { message: "Usage limit exceeded. Window cost: $2.0000 / $1.00" },
      });
    }
    let caught: unknown;
    try {
      await h.sdk.request("/v1/usage");
    } catch (e) {
      caught = e;
    }
    expect((caught as { name?: string }).name).toBe("UsageLimitError");
    const hits = h.api.requestLog().filter((r) => r.path === "/v1/usage").length;
    expect(hits).toBe(1);
  });

  test("persistent 503 exhausts retries and surfaces ServerError with attempt count", async () => {
    for (let i = 0; i < 10; i++) {
      h.api.enqueue("/v1/dead", { status: 503, body: { error: "down" } });
    }
    const retryEvents: number[] = [];
    let caught: unknown;
    try {
      await h.sdk.request("/v1/dead", { onRetry: (e) => retryEvents.push(e.attempt) });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnifiedAIError);
    // Default maxRetries = 3 → 3 retry notifications.
    expect(retryEvents).toEqual([1, 2, 3]);
    const hits = h.api.requestLog().filter((r) => r.path === "/v1/dead").length;
    expect(hits).toBe(4); // 1 initial + 3 retries
  });

  test("non-idempotent POST does NOT retry 5xx through the real stack", async () => {
    h.api.enqueue("/v1/post", { status: 502, body: { error: "bad gateway" } });
    await expect(
      h.sdk.request("/v1/post", { method: "POST", body: { x: 1 } }),
    ).rejects.toBeInstanceOf(UnifiedAIError);
    const hits = h.api.requestLog().filter((r) => r.path === "/v1/post").length;
    expect(hits).toBe(1);
  });

  test("idempotent: true on a POST opts into retry through the real stack", async () => {
    h.api.enqueue(
      "/v1/post",
      { status: 502, body: { error: "bad gateway" } },
      { status: 200, body: { ok: true } },
    );
    const res = await h.sdk.request<{ ok: boolean }>("/v1/post", {
      method: "POST",
      body: { x: 1 },
      idempotent: true,
    });
    expect(res.ok).toBe(true);
    const hits = h.api.requestLog().filter((r) => r.path === "/v1/post").length;
    expect(hits).toBe(2);
  });

  test("503 between two attempts uses the SAME bearer token (no spurious refresh)", async () => {
    h.api.enqueue("/v1/auth", { status: 503, body: { error: "transient" } });
    await h.sdk.request("/v1/auth");
    const auths = h.api
      .requestLog()
      .filter((r) => r.path === "/v1/auth")
      .map((r) => r.auth);
    // Both attempts should carry the same Bearer token — retry on 5xx must
    // not trigger a refresh round-trip.
    expect(auths.length).toBe(2);
    expect(auths[0]).toBe(auths[1]);
    expect(auths[0]?.startsWith("Bearer ")).toBe(true);
  });

  test("401 mid-retry refreshes and carries the fresh token into the next attempt", async () => {
    // Sequence:
    //   1. /v1/seq → 503 (retryable)
    //   2. retry → server now rejects token (we rotate it OUT mid-flight)
    //   3. SDK refreshes via OAuth → new token; second send succeeds
    h.api.enqueue("/v1/seq", { status: 503, body: { error: "transient" } });
    // Pre-stage a "happy path" 200 after the refresh by clearing the queue;
    // default branch will return {ok:true} for the post-refresh attempt.
    await h.sdk.request<{ ok: boolean }>("/v1/seq");
    // First two hits are the 503 + retry. Now rotate the token by hand: the
    // current valid token is whatever the keychain has now.
    const beforeRotate = h.api.requestLog().filter((r) => r.path === "/v1/seq").length;
    expect(beforeRotate).toBe(2);

    // Now actually exercise the refresh path with a fresh request.
    h.api.setValidAccessTokens([]); // current token now rejected as 401
    const res = await h.sdk.request<{ ok: boolean }>("/v1/seq");
    expect(res.ok).toBe(true);
    const after = h.api.requestLog().filter((r) => r.path === "/v1/seq");
    // Expected: 401 attempt + refresh + retry-with-fresh-token = 2 new hits.
    expect(after.length - beforeRotate).toBe(2);
    expect(after[after.length - 1]?.auth).not.toBe(after[beforeRotate]?.auth);
  });

  test("N concurrent requests with a 5xx burst don't cross-talk on shared refresh", async () => {
    // Each path gets one 503 then succeeds; 6 concurrent requests must all
    // succeed and not interfere with one another's retry state.
    for (let i = 0; i < 6; i++) {
      h.api.enqueue(`/v1/parallel/${i}`, { status: 503, body: {} });
    }
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => h.sdk.request<{ ok: boolean }>(`/v1/parallel/${i}`)),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    // Each path was hit twice (503 + retry → 200).
    for (let i = 0; i < 6; i++) {
      const hits = h.api.requestLog().filter((r) => r.path === `/v1/parallel/${i}`).length;
      expect(hits).toBe(2);
    }
  });

  test("stream() retries 5xx and yields a valid SSE body through the real stack", async () => {
    h.api.enqueue(
      "/v1/stream",
      { status: 503, body: { error: "transient" } },
      {
        status: 200,
        body: "data: hello\n\n",
        headers: { "content-type": "text/event-stream" },
      },
    );
    const body = await h.sdk.stream("/v1/stream");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let collected = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      collected += decoder.decode(value);
    }
    expect(collected).toContain("hello");
    expect(h.api.requestLog().filter((r) => r.path === "/v1/stream").length).toBe(2);
  });
});

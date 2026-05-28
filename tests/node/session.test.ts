import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "../../src/core/session";
import { InMemoryKeychain } from "../../src/node/_internal/keychain";
import { UnifiedAI } from "../../src/node/index";
import { startFakeApi } from "../fake-api";
import { startFakeWebAuth } from "../fake-web-auth";

const CLIENT = "app_test";
const USER = "user_test";

interface Harness {
  sdk: UnifiedAI;
  api: Awaited<ReturnType<typeof startFakeApi>>;
  web: Awaited<ReturnType<typeof startFakeWebAuth>>;
  keychain: InMemoryKeychain;
  cleanup: () => Promise<void>;
}

// Mirrors refresh.test.ts's harness but lets each test pick a refresh skew so
// we can either disable proactive refresh (skew 0) or force it to fire within
// test time (a skew just under the fake's 3600s token lifetime).
async function startSdk(opts: { refreshSkewSeconds?: number } = {}): Promise<Harness> {
  const web = await startFakeWebAuth({ userId: USER, expectedClientId: CLIENT });
  const api = await startFakeApi();
  const keychain = new InMemoryKeychain();
  const sdk = new UnifiedAI({
    appId: CLIENT,
    apiUrl: api.baseUrl,
    tokenUrl: web.tokenUrl,
    authorizeUrl: web.authorizeUrl,
    keychain,
    refreshSkewSeconds: opts.refreshSkewSeconds ?? 0,
    env: { read: () => ({ handoffPort: undefined, clientId: undefined }) },
    discovery: { read: async () => null },
    openUrl: async (url) => {
      await fetch(url, { redirect: "follow" });
    },
  });
  await sdk.bootstrap();
  const tokens = (await keychain.get(CLIENT)) as NonNullable<
    Awaited<ReturnType<InMemoryKeychain["get"]>>
  >;
  api.setValidAccessTokens([tokens.access_token]);
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

describe("session surface (node OAuth)", () => {
  test("bootstrap emits signedIn and populates the session", async () => {
    const events: SessionEvent[] = [];
    const web = await startFakeWebAuth({ userId: USER, expectedClientId: CLIENT });
    const api = await startFakeApi();
    const keychain = new InMemoryKeychain();
    const sdk = new UnifiedAI({
      appId: CLIENT,
      apiUrl: api.baseUrl,
      tokenUrl: web.tokenUrl,
      authorizeUrl: web.authorizeUrl,
      keychain,
      refreshSkewSeconds: 0,
      env: { read: () => ({ handoffPort: undefined, clientId: undefined }) },
      discovery: { read: async () => null },
      openUrl: async (url) => {
        await fetch(url, { redirect: "follow" });
      },
    });
    try {
      // Subscribe BEFORE bootstrap so the signedIn event is observed.
      sdk.session.onChange((e) => events.push(e));
      expect(sdk.session.isAuthenticated()).toBe(false);

      await sdk.bootstrap();

      expect(events.map((e) => e.type)).toEqual(["signedIn"]);
      expect(sdk.session.isAuthenticated()).toBe(true);
      expect(sdk.session.status).toBe("active");
      expect(sdk.session.identity).toEqual({ user_id: USER, client_id: CLIENT });
      expect(sdk.session.expiresAt).toBeGreaterThan(Date.now());
    } finally {
      await api.stop();
      await web.stop();
    }
  });

  test("listener fan-out: signedIn → refreshed → signedOut", async () => {
    const h = await startSdk({ refreshSkewSeconds: 0 });
    try {
      const events: SessionEvent[] = [];
      // First listener observes the reactive refresh + sign-out; a second
      // listener proves fan-out to multiple subscribers.
      const second: SessionEvent[] = [];
      h.sdk.session.onChange((e) => events.push(e));
      const unsubscribe = h.sdk.session.onChange((e) => second.push(e));

      // Force a reactive refresh by expiring the live access token.
      h.api.setValidAccessTokens([]);
      await h.sdk.request("/v1/ping");
      expect(events.at(-1)?.type).toBe("refreshed");
      expect(second.at(-1)?.type).toBe("refreshed");

      unsubscribe();
      await h.sdk.signOut();

      expect(events.map((e) => e.type)).toEqual(["refreshed", "signedOut"]);
      // The unsubscribed listener stopped receiving after refreshed.
      expect(second.map((e) => e.type)).toEqual(["refreshed"]);
      expect(h.sdk.session.isAuthenticated()).toBe(false);
      expect(h.sdk.session.status).toBe("signed_out");
    } finally {
      await h.cleanup();
    }
  });

  test("failed refresh emits error then expired", async () => {
    const h = await startSdk({ refreshSkewSeconds: 0 });
    try {
      const events: SessionEvent[] = [];
      h.sdk.session.onChange((e) => events.push(e));

      h.api.setValidAccessTokens([]); // current token expired
      h.web.revokeRefreshTokens(); // refresh will be rejected by the server

      await expect(h.sdk.request("/v1/ping")).rejects.toBeDefined();

      expect(events.map((e) => e.type)).toEqual(["error", "expired"]);
      expect(events[0]?.error).toBeDefined();
      expect(h.sdk.session.isAuthenticated()).toBe(false);
      expect(h.sdk.session.status).toBe("expired");
    } finally {
      await h.cleanup();
    }
  });

  test("proactive refresh fires before expiry without a 401 round-trip", async () => {
    // Skew just under the fake's 3600s lifetime ⇒ the timer fires ~1–2s after
    // bootstrap. The API is never hit, proving the refresh was driven by the
    // expiry timer and not a 401.
    const h = await startSdk({ refreshSkewSeconds: 3598 });
    try {
      const apiCallsAtStart = h.api.requestCount();
      const refreshed = new Promise<SessionEvent>((resolve) => {
        h.sdk.session.onChange((e) => {
          if (e.type === "refreshed") resolve(e);
        });
      });

      const event = await refreshed;

      expect(event.type).toBe("refreshed");
      expect(h.web.refreshCallCount()).toBe(1);
      // No API request was needed to trigger the refresh.
      expect(h.api.requestCount()).toBe(apiCallsAtStart);
      expect(h.sdk.session.isAuthenticated()).toBe(true);
      expect(h.sdk.session.expiresAt).toBeGreaterThan(Date.now());
    } finally {
      await h.cleanup();
    }
  }, 8000);

  test("simultaneous proactive + reactive refresh coalesce into one call", async () => {
    const h = await startSdk({ refreshSkewSeconds: 3598 });
    try {
      // Pin the proactive refresh in flight at the server.
      h.web.pauseRefresh();
      const proactiveStarted = h.web.waitForRefreshStarted();
      await proactiveStarted; // proactive POST is now blocked at /oauth/token

      // While that refresh is blocked, expire the access token and fire a
      // request. Its 401 routes into refreshAccessToken → ensureFreshToken,
      // which must join the in-flight proactive refresh rather than start a
      // second one.
      h.api.setValidAccessTokens([]);
      const reactive = h.sdk.request<{ ok: boolean }>("/v1/ping");

      // Give the reactive request time to issue, see its 401, and coalesce.
      await new Promise((r) => setTimeout(r, 50));

      h.web.releaseRefresh();
      const result = await reactive;

      expect(result.ok).toBe(true);
      // Exactly one refresh hit the server despite two triggers.
      expect(h.web.refreshCallCount()).toBe(1);
    } finally {
      await h.cleanup();
    }
  }, 8000);

  test("signOut cancels a pending proactive refresh", async () => {
    // Skew schedules the timer ~1–2s out. signOut immediately should cancel it
    // so no refresh ever fires, even after the would-fire window passes.
    const h = await startSdk({ refreshSkewSeconds: 3598 });
    try {
      const events: SessionEvent[] = [];
      h.sdk.session.onChange((e) => events.push(e));

      await h.sdk.signOut();
      // Wait well past when the proactive timer would have fired.
      await new Promise((r) => setTimeout(r, 2500));

      expect(h.web.refreshCallCount()).toBe(0);
      expect(events.map((e) => e.type)).toEqual(["signedOut"]);
      expect(h.sdk.session.status).toBe("signed_out");
    } finally {
      await h.cleanup();
    }
  }, 8000);

  test("a failed proactive refresh tears the session down (error → expired)", async () => {
    const h = await startSdk({ refreshSkewSeconds: 3598 });
    try {
      const apiCallsAtStart = h.api.requestCount();
      const events: SessionEvent[] = [];
      const expired = new Promise<void>((resolve) => {
        h.sdk.session.onChange((e) => {
          events.push(e);
          if (e.type === "expired") resolve();
        });
      });

      // The server rejects the refresh; the proactive path must surface error
      // then expired — with no 401/API round-trip involved.
      h.web.revokeRefreshTokens();
      await expired;

      expect(events.map((e) => e.type)).toEqual(["error", "expired"]);
      expect(h.web.refreshCallCount()).toBe(1);
      expect(h.api.requestCount()).toBe(apiCallsAtStart);
      expect(h.sdk.session.status).toBe("expired");
      expect(h.sdk.session.isAuthenticated()).toBe(false);
    } finally {
      await h.cleanup();
    }
  }, 8000);

  test("proactive refresh is disabled when skew is 0", async () => {
    const h = await startSdk({ refreshSkewSeconds: 0 });
    try {
      await new Promise((r) => setTimeout(r, 200));
      expect(h.web.refreshCallCount()).toBe(0);
    } finally {
      await h.cleanup();
    }
  });
});

import { describe, expect, test } from "bun:test";
import { InMemoryKeychain } from "../src/_internal/keychain";
import { UnifiedAI, UnifiedAIAuthError } from "../src/index";
import { startFakeApi } from "./fake-api";
import { startFakeWebAuth } from "./fake-web-auth";

const CLIENT = "app_test";
const USER = "user_test";

interface Harness {
  sdk: UnifiedAI;
  api: Awaited<ReturnType<typeof startFakeApi>>;
  web: Awaited<ReturnType<typeof startFakeWebAuth>>;
  keychain: InMemoryKeychain;
  cleanup: () => Promise<void>;
}

// Bootstrap via a real PKCE round-trip against the fake web auth server so
// the refresh token is one the fake will actually accept on /oauth/token.
async function startSdk(): Promise<Harness> {
  const web = await startFakeWebAuth({ userId: USER, expectedClientId: CLIENT });
  const api = await startFakeApi();
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
  });
  await sdk.bootstrap();
  const tokens = (await keychain.get(CLIENT)) as NonNullable<
    Awaited<ReturnType<InMemoryKeychain["get"]>>
  >;
  api.setValidAccessTokens([tokens.access_token]);
  // Whenever the SDK persists a refreshed token, keep the api's accepted-token
  // set in sync. This is the test-side mirror of "new access token is now live".
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

describe("transport refresh-on-401", () => {
  test("401 then 200 round-trip: transparent refresh", async () => {
    const h = await startSdk();
    try {
      h.api.setValidAccessTokens([]); // current access token is now expired
      const result = await h.sdk.request<{ ok: boolean }>("/v1/ping");
      expect(result.ok).toBe(true);
      expect(h.web.refreshCallCount()).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test("N concurrent 401s trigger exactly one refresh", async () => {
    const h = await startSdk();
    try {
      h.api.setValidAccessTokens([]);
      const N = 8;
      const results = await Promise.all(
        Array.from({ length: N }, () => h.sdk.request<{ ok: boolean }>("/v1/ping")),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      expect(h.web.refreshCallCount()).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test("refresh failure throws UnifiedAIAuthError and clears keychain", async () => {
    const h = await startSdk();
    try {
      h.api.setValidAccessTokens([]);
      h.web.revokeRefreshTokens();
      await expect(h.sdk.request("/v1/ping")).rejects.toBeInstanceOf(UnifiedAIAuthError);
      expect(await h.keychain.get(CLIENT)).toBeNull();
    } finally {
      await h.cleanup();
    }
  });

  test("retry-still-401 throws UnifiedAIAuthError and clears keychain", async () => {
    const h = await startSdk();
    try {
      h.api.forceAlways401(true);
      await expect(h.sdk.request("/v1/ping")).rejects.toBeInstanceOf(UnifiedAIAuthError);
      expect(await h.keychain.get(CLIENT)).toBeNull();
    } finally {
      await h.cleanup();
    }
  });

  test("successful refresh persists new tokens to keychain", async () => {
    const h = await startSdk();
    try {
      const before = (await h.keychain.get(CLIENT)) as NonNullable<
        Awaited<ReturnType<InMemoryKeychain["get"]>>
      >;
      h.api.setValidAccessTokens([]);
      await h.sdk.request("/v1/ping");
      const after = (await h.keychain.get(CLIENT)) as NonNullable<
        Awaited<ReturnType<InMemoryKeychain["get"]>>
      >;
      expect(after.access_token).not.toBe(before.access_token);
      expect(after.refresh_token).not.toBe(before.refresh_token);
    } finally {
      await h.cleanup();
    }
  });
});

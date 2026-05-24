import { describe, expect, test } from "bun:test";
import { InMemoryKeychain } from "../../src/node/_internal/keychain";
import { UnifiedAI, UnifiedAIAuthError } from "../../src/node/index";
import { startFakeApi } from "../fake-api";
import { startFakeWebAuth } from "../fake-web-auth";

const CLIENT = "app_test";
const USER = "user_test";

async function startSdk() {
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

describe("signOut() server-side revoke", () => {
  test("posts current refresh token to /oauth/revoke and clears local state", async () => {
    const h = await startSdk();
    try {
      const stored = (await h.keychain.get(CLIENT)) as NonNullable<
        Awaited<ReturnType<InMemoryKeychain["get"]>>
      >;
      await h.sdk.signOut();
      const calls = h.web.revokeCalls();
      expect(calls.length).toBe(1);
      const call = calls[0];
      if (!call) throw new Error("expected revoke call");
      expect(call.token).toBe(stored.refresh_token);
      expect(call.client_id).toBe(CLIENT);
      expect(call.token_type_hint).toBe("refresh_token");
      expect(await h.keychain.get(CLIENT)).toBeNull();
      // Refresh against the now-revoked token returns invalid_grant.
      await expect(
        h.sdk.request("/v1/ping").catch((e) => {
          throw e;
        }),
      ).rejects.toBeDefined();
    } finally {
      await h.cleanup();
    }
  });

  test("revoked refresh token can no longer obtain new tokens", async () => {
    const h = await startSdk();
    try {
      const stored = (await h.keychain.get(CLIENT)) as NonNullable<
        Awaited<ReturnType<InMemoryKeychain["get"]>>
      >;
      h.api.setValidAccessTokens([stored.access_token]);
      await h.sdk.signOut();
      // Re-seat the just-revoked tokens and attempt a refresh — should fail.
      await h.keychain.set(CLIENT, stored);
      const sdk2 = new UnifiedAI({
        appId: CLIENT,
        apiUrl: h.api.baseUrl,
        tokenUrl: h.web.tokenUrl,
        authorizeUrl: h.web.authorizeUrl,
        keychain: h.keychain,
        env: { read: () => ({ handoffPort: undefined, clientId: undefined }) },
        discovery: { read: async () => null },
        openUrl: async () => {},
      });
      await sdk2.bootstrap();
      h.api.setValidAccessTokens([]); // force a refresh on next request
      await expect(sdk2.request("/v1/ping")).rejects.toBeInstanceOf(UnifiedAIAuthError);
    } finally {
      await h.cleanup();
    }
  });

  test("server unreachable: local sign-out still succeeds", async () => {
    const h = await startSdk();
    try {
      await h.web.stop();
      await h.sdk.signOut();
      expect(await h.keychain.get(CLIENT)).toBeNull();
    } finally {
      await h.api.stop();
    }
  });

  test("server returns 5xx: local sign-out still succeeds", async () => {
    const h = await startSdk();
    try {
      h.web.failRevoke(500);
      await h.sdk.signOut();
      expect(h.web.revokeCalls().length).toBe(1);
      expect(await h.keychain.get(CLIENT)).toBeNull();
    } finally {
      await h.cleanup();
    }
  });

  test("revokeUrl defaults to deriving from tokenUrl (/oauth/token → /oauth/revoke)", async () => {
    const h = await startSdk();
    try {
      // No explicit revokeUrl was passed in startSdk; the call still lands.
      await h.sdk.signOut();
      expect(h.web.revokeCalls().length).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test("UNIFIEDAI_REVOKE_URL env override is honored", async () => {
    const web1 = await startFakeWebAuth({ userId: USER, expectedClientId: CLIENT });
    const web2 = await startFakeWebAuth({ userId: USER, expectedClientId: CLIENT });
    const api = await startFakeApi();
    const keychain = new InMemoryKeychain();
    const prev = process.env.UNIFIEDAI_REVOKE_URL;
    process.env.UNIFIEDAI_REVOKE_URL = web2.revokeUrl;
    try {
      const sdk = new UnifiedAI({
        appId: CLIENT,
        apiUrl: api.baseUrl,
        tokenUrl: web1.tokenUrl,
        authorizeUrl: web1.authorizeUrl,
        keychain,
        env: { read: () => ({ handoffPort: undefined, clientId: undefined }) },
        discovery: { read: async () => null },
        openUrl: async (url) => {
          await fetch(url, { redirect: "follow" });
        },
      });
      await sdk.bootstrap();
      await sdk.signOut();
      expect(web1.revokeCalls().length).toBe(0);
      expect(web2.revokeCalls().length).toBe(1);
    } finally {
      process.env.UNIFIEDAI_REVOKE_URL = prev;
      await api.stop();
      await web1.stop();
      await web2.stop();
    }
  });
});

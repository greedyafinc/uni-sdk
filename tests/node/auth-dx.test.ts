import { describe, expect, test } from "bun:test";
import type { TokenSet } from "../../src/core/_internal/tokens";
import type { DiscoveryReader } from "../../src/node/_internal/discovery";
import { type EnvReader, defaultEnvReader } from "../../src/node/_internal/env";
import { InMemoryKeychain } from "../../src/node/_internal/keychain";
import { type AuthEvent, UnifiedAI, UnifiedAIAuthError } from "../../src/node/index";
import { startFakeApi } from "../fake-api";
import { startFakeDesktop } from "../fake-desktop";
import { startFakeWebAuth } from "../fake-web-auth";

const CLIENT = "app_test";
const USER = "user_test";
const emptyDiscovery: DiscoveryReader = { read: async () => null };
const envWith = (port: number | undefined): EnvReader => ({
  read: () => ({ handoffPort: port, clientId: undefined }),
});

function seedTokens(): TokenSet {
  return {
    access_token: "a",
    refresh_token: "r",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user_id: USER,
    client_id: CLIENT,
  };
}

describe("lazy auto-bootstrap", () => {
  test("first request bootstraps automatically (keychain hit), no explicit bootstrap()", async () => {
    const api = await startFakeApi(["a"]);
    const keychain = new InMemoryKeychain();
    await keychain.set(CLIENT, seedTokens());
    let openUrlCalls = 0;
    try {
      const sdk = new UnifiedAI({
        appId: CLIENT,
        apiUrl: api.baseUrl,
        keychain,
        env: envWith(undefined),
        discovery: emptyDiscovery,
        openUrl: async () => {
          openUrlCalls++;
        },
      });
      // No bootstrap() call — the request path must run the ladder itself.
      await sdk.request("/v1/ping");
      expect(api.requestCount()).toBe(1);
      expect(sdk.identity()).toEqual({ user_id: USER, client_id: CLIENT });
      expect(sdk.session.isAuthenticated()).toBe(true);
      expect(openUrlCalls).toBe(0);
    } finally {
      await api.stop();
    }
  });

  test("concurrent first requests share a single bootstrap (single-flight)", async () => {
    const api = await startFakeApi(["a"]);
    const keychain = new InMemoryKeychain();
    await keychain.set(CLIENT, seedTokens());
    let keychainGets = 0;
    const originalGet = keychain.get.bind(keychain);
    keychain.get = async (clientId: string) => {
      keychainGets++;
      // Yield so both concurrent requests are inside getInitialAccessToken
      // before the first bootstrap resolves.
      await new Promise((r) => setTimeout(r, 10));
      return originalGet(clientId);
    };
    try {
      const sdk = new UnifiedAI({
        appId: CLIENT,
        apiUrl: api.baseUrl,
        keychain,
        env: envWith(undefined),
        discovery: emptyDiscovery,
        openUrl: async () => {},
      });
      await Promise.all([sdk.request("/v1/ping"), sdk.request("/v1/ping")]);
      // One doBootstrap → one keychain lookup, even with two racing requests.
      expect(keychainGets).toBe(1);
      expect(api.requestCount()).toBe(2);
    } finally {
      await api.stop();
    }
  });

  test("signOut is terminal for lazy bootstrap: next request throws, no silent re-auth", async () => {
    const web = await startFakeWebAuth({ userId: USER, expectedClientId: CLIENT });
    const api = await startFakeApi(["a"]);
    const keychain = new InMemoryKeychain();
    await keychain.set(CLIENT, seedTokens());
    let openUrlCalls = 0;
    try {
      const sdk = new UnifiedAI({
        appId: CLIENT,
        apiUrl: api.baseUrl,
        tokenUrl: web.tokenUrl,
        authorizeUrl: web.authorizeUrl,
        keychain,
        env: envWith(undefined),
        discovery: emptyDiscovery,
        openUrl: async (url) => {
          openUrlCalls++;
          await fetch(url, { redirect: "follow" });
        },
      });
      await sdk.request("/v1/ping"); // lazy bootstrap
      await sdk.signOut();
      // The signed-out contract is preserved: the request path must NOT
      // silently re-run the ladder (which could open a browser).
      await expect(sdk.request("/v1/ping")).rejects.toMatchObject({
        code: "not_bootstrapped",
      });
      expect(openUrlCalls).toBe(0);
      // Explicit bootstrap() after signOut still re-authenticates (keychain
      // was cleared, so the ladder falls through to browser PKCE).
      await sdk.bootstrap();
      expect(openUrlCalls).toBe(1);
      expect(sdk.identity()).toEqual({ user_id: USER, client_id: CLIENT });
    } finally {
      await api.stop();
      await web.stop();
    }
  });

  test("explicit bootstrap() before any request keeps working identically", async () => {
    const api = await startFakeApi(["a"]);
    const keychain = new InMemoryKeychain();
    await keychain.set(CLIENT, seedTokens());
    try {
      const sdk = new UnifiedAI({
        appId: CLIENT,
        apiUrl: api.baseUrl,
        keychain,
        env: envWith(undefined),
        discovery: emptyDiscovery,
        openUrl: async () => {},
      });
      await sdk.bootstrap();
      await sdk.request("/v1/ping");
      expect(api.requestCount()).toBe(1);
    } finally {
      await api.stop();
    }
  });
});

describe("onAuthEvent", () => {
  test("keychain miss → env handoff success emits the expected sequence", async () => {
    const desktop = await startFakeDesktop({ knownClientId: CLIENT, userId: USER });
    const events: AuthEvent[] = [];
    try {
      const sdk = new UnifiedAI({
        appId: CLIENT,
        keychain: new InMemoryKeychain(),
        env: envWith(desktop.port),
        discovery: emptyDiscovery,
        onAuthEvent: (e) => events.push(e),
      });
      await sdk.bootstrap();
      expect(events).toEqual([
        { type: "keychain_lookup", result: "miss" },
        { type: "handoff_attempt", source: "env", port: desktop.port },
        { type: "handoff_result", source: "env", result: "success" },
      ]);
    } finally {
      await desktop.stop();
    }
  });

  test("keychain hit emits a hit event and stops the ladder", async () => {
    const keychain = new InMemoryKeychain();
    await keychain.set(CLIENT, seedTokens());
    const events: AuthEvent[] = [];
    const sdk = new UnifiedAI({
      appId: CLIENT,
      keychain,
      env: envWith(undefined),
      discovery: emptyDiscovery,
      onAuthEvent: (e) => events.push(e),
    });
    await sdk.bootstrap();
    expect(events).toEqual([{ type: "keychain_lookup", result: "hit" }]);
  });

  test("a throwing listener does not break auth", async () => {
    const desktop = await startFakeDesktop({ knownClientId: CLIENT, userId: USER });
    const seen: string[] = [];
    try {
      const sdk = new UnifiedAI({
        appId: CLIENT,
        keychain: new InMemoryKeychain(),
        env: envWith(desktop.port),
        discovery: emptyDiscovery,
        onAuthEvent: (e) => {
          seen.push(e.type);
          throw new Error("host telemetry exploded");
        },
      });
      await sdk.bootstrap();
      expect(sdk.identity()).toEqual({ user_id: USER, client_id: CLIENT });
      // Every step still fired despite the listener throwing each time.
      expect(seen).toEqual(["keychain_lookup", "handoff_attempt", "handoff_result"]);
    } finally {
      await desktop.stop();
    }
  });

  test("failed refresh emits refresh_start then refresh_failure", async () => {
    const web = await startFakeWebAuth({ userId: USER, expectedClientId: CLIENT });
    const api = await startFakeApi(["a"]);
    const keychain = new InMemoryKeychain();
    // Seed a refresh token the fake auth server never issued — the refresh
    // triggered by a 401 will be rejected as invalid_grant.
    await keychain.set(CLIENT, seedTokens());
    const events: AuthEvent[] = [];
    try {
      const sdk = new UnifiedAI({
        appId: CLIENT,
        apiUrl: api.baseUrl,
        tokenUrl: web.tokenUrl,
        authorizeUrl: web.authorizeUrl,
        keychain,
        env: envWith(undefined),
        discovery: emptyDiscovery,
        openUrl: async () => {},
        onAuthEvent: (e) => events.push(e),
      });
      await sdk.bootstrap();
      api.setValidAccessTokens([]); // force a 401 on the next request
      await expect(sdk.request("/v1/ping")).rejects.toBeInstanceOf(UnifiedAIAuthError);
      const refreshEvents = events.filter((e) => e.type.startsWith("refresh"));
      expect(refreshEvents).toEqual([
        { type: "refresh_start" },
        { type: "refresh_failure", code: "auth_refresh_failed" },
      ]);
    } finally {
      await api.stop();
      await web.stop();
    }
  });

  test("signOut emits a sign_out event", async () => {
    const web = await startFakeWebAuth({ userId: USER, expectedClientId: CLIENT });
    const keychain = new InMemoryKeychain();
    await keychain.set(CLIENT, seedTokens());
    const events: AuthEvent[] = [];
    try {
      const sdk = new UnifiedAI({
        appId: CLIENT,
        tokenUrl: web.tokenUrl,
        authorizeUrl: web.authorizeUrl,
        keychain,
        env: envWith(undefined),
        discovery: emptyDiscovery,
        onAuthEvent: (e) => events.push(e),
      });
      await sdk.bootstrap();
      await sdk.signOut();
      expect(events.map((e) => e.type)).toContain("sign_out");
    } finally {
      await web.stop();
    }
  });
});

describe("EnvReader-sourced configuration", () => {
  test("authorizeUrl and tokenUrl injected via EnvReader drive browser PKCE", async () => {
    const web = await startFakeWebAuth({ userId: USER, expectedClientId: CLIENT });
    const keychain = new InMemoryKeychain();
    const opened: string[] = [];
    try {
      const sdk = new UnifiedAI({
        appId: CLIENT,
        keychain,
        // URLs come ONLY from the injected reader — no authorizeUrl/tokenUrl
        // options, no process.env.
        env: {
          read: () => ({
            handoffPort: undefined,
            clientId: undefined,
            authorizeUrl: web.authorizeUrl,
            tokenUrl: web.tokenUrl,
          }),
        },
        discovery: emptyDiscovery,
        openUrl: async (url) => {
          opened.push(url);
          await fetch(url, { redirect: "follow" });
        },
      });
      await sdk.bootstrap();
      expect(sdk.identity()).toEqual({ user_id: USER, client_id: CLIENT });
      expect(opened[0]?.startsWith(web.authorizeUrl)).toBe(true);
    } finally {
      await web.stop();
    }
  });

  test("defaultEnvReader reads all UNIFIEDAI_* variables from process.env", () => {
    const NAMES = [
      "UNIFIEDAI_HANDOFF_PORT",
      "UNIFIEDAI_CLIENT_ID",
      "UNIFIEDAI_HANDOFF_TOKEN",
      "UNIFIEDAI_AUTHORIZE_URL",
      "UNIFIEDAI_TOKEN_URL",
      "UNIFIEDAI_REVOKE_URL",
    ] as const;
    const prev = new Map<string, string | undefined>(NAMES.map((n) => [n, process.env[n]]));
    try {
      process.env.UNIFIEDAI_HANDOFF_PORT = "4242";
      process.env.UNIFIEDAI_CLIENT_ID = "app_env";
      process.env.UNIFIEDAI_HANDOFF_TOKEN = "launch-secret";
      process.env.UNIFIEDAI_AUTHORIZE_URL = "https://auth.example/authorize";
      process.env.UNIFIEDAI_TOKEN_URL = "https://auth.example/token";
      process.env.UNIFIEDAI_REVOKE_URL = "https://auth.example/revoke";
      expect(defaultEnvReader.read()).toEqual({
        handoffPort: 4242,
        clientId: "app_env",
        handoffToken: "launch-secret",
        authorizeUrl: "https://auth.example/authorize",
        tokenUrl: "https://auth.example/token",
        revokeUrl: "https://auth.example/revoke",
      });
    } finally {
      for (const [name, value] of prev) {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, name);
        } else {
          process.env[name] = value;
        }
      }
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InMemoryKeychain } from "../../src/node/_internal/keychain";
import type { TokenSet } from "../../src/core/_internal/tokens";
import { UnifiedAI, UnifiedError } from "../../src/node/index";

describe("UnifiedAI", () => {
  test("can be instantiated with no arguments", () => {
    const sdk = new UnifiedAI();
    expect(sdk).toBeInstanceOf(UnifiedAI);
  });

  test("accepts options", () => {
    const sdk = new UnifiedAI({ appId: "app_test", apiUrl: "https://api.test" });
    expect(sdk).toBeInstanceOf(UnifiedAI);
  });
});

describe("UnifiedAI apiUrl default", () => {
  const ORIG_ENV_URL = process.env.UNIFIEDAI_API_URL;

  beforeEach(() => {
    process.env.UNIFIEDAI_API_URL = undefined;
  });

  afterEach(() => {
    process.env.UNIFIEDAI_API_URL = ORIG_ENV_URL;
  });

  test("requests use the production base when apiUrl is not provided", async () => {
    const keychain = new InMemoryKeychain();
    const tokens: TokenSet = {
      access_token: "t",
      refresh_token: "r",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user_id: "u",
      client_id: "app_test",
    };
    await keychain.set("app_test", tokens);
    const calls: string[] = [];
    const fakeFetch = (async (input: URL | RequestInfo) => {
      calls.push(typeof input === "string" ? input : (input as Request | URL).toString());
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      appId: "app_test",
      keychain,
      env: { read: () => ({ handoffPort: undefined, clientId: undefined }) },
      discovery: { read: async () => null },
      openUrl: async () => {},
      fetch: fakeFetch,
    });
    await sdk.bootstrap();
    await sdk.request("/v1/messages", { method: "POST", body: { model: "auto" } });
    expect(calls[0]).toBe("https://api.unifiedai.app/v1/messages");
  });

  test("UNIFIEDAI_API_URL env var overrides the default", async () => {
    process.env.UNIFIEDAI_API_URL = "https://staging.example.com";
    const keychain = new InMemoryKeychain();
    const tokens: TokenSet = {
      access_token: "t",
      refresh_token: "r",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user_id: "u",
      client_id: "app_test",
    };
    await keychain.set("app_test", tokens);
    const calls: string[] = [];
    const fakeFetch = (async (input: URL | RequestInfo) => {
      calls.push(typeof input === "string" ? input : (input as Request | URL).toString());
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      appId: "app_test",
      keychain,
      env: { read: () => ({ handoffPort: undefined, clientId: undefined }) },
      discovery: { read: async () => null },
      openUrl: async () => {},
      fetch: fakeFetch,
    });
    await sdk.bootstrap();
    await sdk.request("/api/v1/models", { method: "GET" });
    expect(calls[0]).toBe("https://staging.example.com/api/v1/models");
  });

  test("explicit apiUrl option still wins over env and default", async () => {
    process.env.UNIFIEDAI_API_URL = "https://staging.example.com";
    const keychain = new InMemoryKeychain();
    const tokens: TokenSet = {
      access_token: "t",
      refresh_token: "r",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user_id: "u",
      client_id: "app_test",
    };
    await keychain.set("app_test", tokens);
    const calls: string[] = [];
    const fakeFetch = (async (input: URL | RequestInfo) => {
      calls.push(typeof input === "string" ? input : (input as Request | URL).toString());
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      appId: "app_test",
      apiUrl: "http://localhost:3141",
      keychain,
      env: { read: () => ({ handoffPort: undefined, clientId: undefined }) },
      discovery: { read: async () => null },
      openUrl: async () => {},
      fetch: fakeFetch,
    });
    await sdk.bootstrap();
    await sdk.request("/api/v1/models", { method: "GET" });
    expect(calls[0]).toBe("http://localhost:3141/api/v1/models");
  });
});

describe("UnifiedError", () => {
  test("carries a code and optional status", () => {
    const err = new UnifiedError("not_implemented", "nope", 501);
    expect(err.code).toBe("not_implemented");
    expect(err.status).toBe(501);
    expect(err).toBeInstanceOf(Error);
  });
});

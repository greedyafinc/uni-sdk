import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TokenSet } from "../../src/core/_internal/tokens";
import { InMemoryKeychain } from "../../src/node/_internal/keychain";
import { UnifiedAI, UnifiedAIError, type UsageResponse } from "../../src/node/index";

const CLIENT = "app_test";
const USER = "user_test";
const ACCESS_TOKEN = "access_test";

const SAMPLE_USAGE: UsageResponse = {
  plan: {
    id: 1,
    name: "free",
    limit: 1.0,
    limit_period_seconds: 86400,
    monthly_price: null,
    annual_price: null,
  },
  period: {
    input_tokens: 1234,
    output_tokens: 567,
    request_count: 8,
    cost: 0.0421,
    started_at: "2026-05-22T00:00:00Z",
    resets_at: "2026-05-23T00:00:00Z",
    days_remaining: 0,
  },
  daily: {
    used: 0.0421,
    limit: 1.0,
    resets_at: "2026-05-23T00:00:00Z",
  },
  credits: {
    balance: 4.9579,
  },
};

interface FakeUnifiedApi {
  baseUrl: string;
  stop: () => Promise<void>;
  setResponse: (init: { status: number; body: unknown }) => void;
  lastAuth: () => string;
  lastPath: () => string;
}

async function startFakeUnifiedApi(): Promise<FakeUnifiedApi> {
  let response: { status: number; body: unknown } = {
    status: 200,
    body: SAMPLE_USAGE,
  };
  let lastAuth = "";
  let lastPath = "";
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      lastAuth = req.headers.get("authorization") ?? "";
      lastPath = new URL(req.url).pathname;
      const body =
        typeof response.body === "string" ? response.body : JSON.stringify(response.body);
      return new Response(body, {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      await server.stop(true);
    },
    setResponse: (init) => {
      response = init;
    },
    lastAuth: () => lastAuth,
    lastPath: () => lastPath,
  };
}

function makeSdk(api: FakeUnifiedApi, keychain: InMemoryKeychain): UnifiedAI {
  return new UnifiedAI({
    appId: CLIENT,
    apiUrl: api.baseUrl,
    keychain,
    env: { read: () => ({ handoffPort: undefined, clientId: undefined }) },
    discovery: { read: async () => null },
    openUrl: async () => {},
  });
}

async function seedTokens(keychain: InMemoryKeychain): Promise<void> {
  const tokens: TokenSet = {
    access_token: ACCESS_TOKEN,
    refresh_token: "refresh_test",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user_id: USER,
    client_id: CLIENT,
  };
  await keychain.set(CLIENT, tokens);
}

describe("sdk.usage.get", () => {
  let api: FakeUnifiedApi;
  let keychain: InMemoryKeychain;
  let sdk: UnifiedAI;

  beforeEach(async () => {
    api = await startFakeUnifiedApi();
    keychain = new InMemoryKeychain();
    await seedTokens(keychain);
    sdk = makeSdk(api, keychain);
    await sdk.bootstrap();
  });

  afterEach(async () => {
    await api.stop();
  });

  test("returns typed usage and sends bearer token to /api/v1/usage", async () => {
    const res = await sdk.usage.get();
    expect(res.period.input_tokens).toBe(1234);
    expect(res.period.output_tokens).toBe(567);
    expect(res.period.request_count).toBe(8);
    expect(res.period.cost).toBeCloseTo(0.0421);
    expect(res.daily.used).toBeCloseTo(0.0421);
    expect(res.daily.limit).toBe(1.0);
    expect(res.daily.resets_at).toBe("2026-05-23T00:00:00Z");
    expect(res.credits.balance).toBeCloseTo(4.9579);
    expect(api.lastAuth()).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(api.lastPath()).toBe("/api/v1/usage");
  });

  test("non-2xx throws UnifiedAIError with status and server body", async () => {
    api.setResponse({ status: 403, body: { error: "forbidden" } });
    let caught: unknown;
    try {
      await sdk.usage.get();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnifiedAIError);
    const e = caught as UnifiedAIError;
    expect(e.status).toBe(403);
    expect(e.code).toBe("forbidden");
    expect(e.body).toEqual({ error: "forbidden" });
  });

  test("5xx maps to server_error", async () => {
    api.setResponse({ status: 500, body: "boom" });
    const p = sdk.usage.get();
    await expect(p).rejects.toBeInstanceOf(UnifiedAIError);
    try {
      await p;
    } catch (err) {
      expect((err as UnifiedAIError).code).toBe("server_error");
    }
  });
});

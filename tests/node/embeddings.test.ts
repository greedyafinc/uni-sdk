import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TokenSet } from "../../src/core/_internal/tokens";
import { UnifiedAIError } from "../../src/core/errors";
import { InMemoryKeychain } from "../../src/node/_internal/keychain";
import { UnifiedAI } from "../../src/node/index";

const CLIENT = "app_test";
const USER = "user_test";
const ACCESS_TOKEN = "access_test";

interface CapturedRequest {
  path: string;
  method: string;
  auth: string;
  contentType: string;
  json: unknown;
}

interface FakeApi {
  baseUrl: string;
  stop: () => Promise<void>;
  setResponse: (init: { status: number; body: unknown }) => void;
  lastRequest: () => CapturedRequest;
}

async function startFakeApi(): Promise<FakeApi> {
  let response: { status: number; body: unknown } = { status: 200, body: {} };
  let last: CapturedRequest = {
    path: "",
    method: "",
    auth: "",
    contentType: "",
    json: undefined,
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      const text = await req.text();
      let parsed: unknown = undefined;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
      }
      last = {
        path: url.pathname,
        method: req.method,
        auth: req.headers.get("authorization") ?? "",
        contentType: req.headers.get("content-type") ?? "",
        json: parsed,
      };
      const out = typeof response.body === "string" ? response.body : JSON.stringify(response.body);
      return new Response(out, {
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
    lastRequest: () => last,
  };
}

function makeSdk(api: FakeApi, keychain: InMemoryKeychain): UnifiedAI {
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

const SAMPLE_EMBEDDING_RESPONSE = {
  object: "list",
  data: [
    {
      object: "embedding",
      embedding: [0.1, 0.2, 0.3],
      index: 0,
    },
  ],
  model: "togethercomputer/m2-bert-80M-8k-retrieval",
  usage: { prompt_tokens: 5, total_tokens: 5 },
};

describe("sdk.embeddings", () => {
  let api: FakeApi;
  let keychain: InMemoryKeychain;
  let sdk: UnifiedAI;

  beforeEach(async () => {
    api = await startFakeApi();
    keychain = new InMemoryKeychain();
    await seedTokens(keychain);
    sdk = makeSdk(api, keychain);
    await sdk.bootstrap();
  });

  afterEach(async () => {
    await api.stop();
  });

  test("create posts a string input to /api/v1/embeddings and parses the response", async () => {
    api.setResponse({ status: 200, body: SAMPLE_EMBEDDING_RESPONSE });
    const res = await sdk.embeddings.create({
      model: "togethercomputer/m2-bert-80M-8k-retrieval",
      input: "hello world",
    });
    expect(res.object).toBe("list");
    expect(res.data).toHaveLength(1);
    expect(res.data[0]?.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(res.data[0]?.index).toBe(0);
    expect(res.usage.prompt_tokens).toBe(5);

    const r = api.lastRequest();
    expect(r.method).toBe("POST");
    expect(r.path).toBe("/api/v1/embeddings");
    expect(r.auth).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(r.contentType).toContain("application/json");
    expect(r.json).toMatchObject({
      model: "togethercomputer/m2-bert-80M-8k-retrieval",
      input: "hello world",
    });
  });

  test("create posts an array input and forwards optional fields", async () => {
    const body = {
      object: "list",
      data: [
        { object: "embedding", embedding: [0.1], index: 0 },
        { object: "embedding", embedding: [0.2], index: 1 },
      ],
      model: "togethercomputer/m2-bert-80M-8k-retrieval",
      usage: { prompt_tokens: 10, total_tokens: 10 },
    };
    api.setResponse({ status: 200, body });
    const res = await sdk.embeddings.create({
      model: "togethercomputer/m2-bert-80M-8k-retrieval",
      input: ["one", "two"],
      encoding_format: "float",
      dimensions: 1,
      user: "user-42",
    });
    expect(res.data).toHaveLength(2);

    const r = api.lastRequest();
    expect(r.json).toMatchObject({
      input: ["one", "two"],
      encoding_format: "float",
      dimensions: 1,
      user: "user-42",
    });
  });

  test("create surfaces non-2xx responses as UnifiedAIError", async () => {
    api.setResponse({
      status: 400,
      body: { error: { message: "model not found", type: "invalid_request_error" } },
    });
    let caught: unknown;
    try {
      await sdk.embeddings.create({ model: "bogus", input: "x" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnifiedAIError);
    const err = caught as UnifiedAIError;
    expect(err.status).toBe(400);
    expect(err.message).toContain("model not found");
  });
});

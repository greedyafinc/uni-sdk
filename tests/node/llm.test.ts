import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InMemoryKeychain } from "../../src/node/_internal/keychain";
import type { TokenSet } from "../../src/core/_internal/tokens";
import { UnifiedAI, UnifiedAIError } from "../../src/node/index";

const CLIENT = "app_test";
const USER = "user_test";
const ACCESS_TOKEN = "access_test";

interface FakeLlmApi {
  baseUrl: string;
  stop: () => Promise<void>;
  setResponse: (init: { status: number; body: unknown }) => void;
  lastRequest: () => { path: string; method: string; auth: string; body: unknown };
}

async function startFakeLlmApi(): Promise<FakeLlmApi> {
  let response: { status: number; body: unknown } = { status: 200, body: {} };
  let last: { path: string; method: string; auth: string; body: unknown } = {
    path: "",
    method: "",
    auth: "",
    body: undefined,
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      let body: unknown = undefined;
      const text = await req.text();
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      last = {
        path: url.pathname,
        method: req.method,
        auth: req.headers.get("authorization") ?? "",
        body,
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

function makeSdk(api: FakeLlmApi, keychain: InMemoryKeychain): UnifiedAI {
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

describe("LLM sub-clients", () => {
  let api: FakeLlmApi;
  let keychain: InMemoryKeychain;
  let sdk: UnifiedAI;

  beforeEach(async () => {
    api = await startFakeLlmApi();
    keychain = new InMemoryKeychain();
    await seedTokens(keychain);
    sdk = makeSdk(api, keychain);
    await sdk.bootstrap();
  });

  afterEach(async () => {
    await api.stop();
  });

  test("sdk.chat.completions.create posts typed body and parses response", async () => {
    api.setResponse({
      status: 200,
      body: {
        id: "cmpl-1",
        object: "chat.completion",
        created: 1700000000,
        model: "openai/gpt-4o-mini",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hi" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      },
    });
    const res = await sdk.chat.completions.create({
      model: "auto",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(res.object).toBe("chat.completion");
    expect(res.choices[0]?.message.content).toBe("hi");
    const r = api.lastRequest();
    expect(r.method).toBe("POST");
    expect(r.path).toBe("/api/v1/chat/completions");
    expect(r.auth).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect((r.body as { model: string }).model).toBe("auto");
  });

  test("sdk.responses.create posts to /api/v1/responses", async () => {
    api.setResponse({
      status: 200,
      body: {
        id: "resp_1",
        object: "response",
        created_at: 1700000000,
        model: "openai/gpt-4o-mini",
        output: [],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        status: "completed",
      },
    });
    const res = await sdk.responses.create({ model: "auto", input: "hi" });
    expect(res.object).toBe("response");
    expect(res.status).toBe("completed");
    const r = api.lastRequest();
    expect(r.path).toBe("/api/v1/responses");
    expect(r.method).toBe("POST");
    expect((r.body as { input: string }).input).toBe("hi");
  });

  test("sdk.messages.create posts to /v1/messages", async () => {
    api.setResponse({
      status: 200,
      body: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        model: "anthropic/claude-haiku",
        stop_reason: "end_turn",
        usage: { input_tokens: 4, output_tokens: 2 },
      },
    });
    const res = await sdk.messages.create({
      model: "auto",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.type).toBe("message");
    expect(res.content[0]?.type).toBe("text");
    const r = api.lastRequest();
    expect(r.path).toBe("/v1/messages");
    expect(r.method).toBe("POST");
    expect((r.body as { max_tokens: number }).max_tokens).toBe(64);
  });

  test("non-2xx surfaces UnifiedAIError with status and body", async () => {
    api.setResponse({ status: 400, body: { error: "bad model" } });
    let caught: unknown;
    try {
      await sdk.chat.completions.create({
        model: "nope",
        messages: [{ role: "user", content: "hi" }],
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnifiedAIError);
    const e = caught as UnifiedAIError;
    expect(e.status).toBe(400);
    expect(e.body).toEqual({ error: "bad model" });
  });
});

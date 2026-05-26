import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TokenSet } from "../../src/core/_internal/tokens";
import { BadRequestError, UnifiedAIError } from "../../src/core/errors";
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
  setResponse: (init: {
    status: number;
    body?: unknown;
    bytes?: Uint8Array;
    contentType?: string;
  }) => void;
  lastRequest: () => CapturedRequest;
}

async function startFakeApi(): Promise<FakeApi> {
  let response: {
    status: number;
    body?: unknown;
    bytes?: Uint8Array;
    contentType?: string;
  } = { status: 200, body: {} };
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
      if (response.bytes) {
        return new Response(response.bytes as BlobPart, {
          status: response.status,
          headers: { "content-type": response.contentType ?? "application/octet-stream" },
        });
      }
      const out = typeof response.body === "string" ? response.body : JSON.stringify(response.body);
      return new Response(out, {
        status: response.status,
        headers: { "content-type": response.contentType ?? "application/json" },
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

describe("sdk.audio", () => {
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

  test("speech posts JSON to /api/v1/audio/speech and returns binary bytes", async () => {
    const audioBytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x01, 0x02, 0x03]);
    api.setResponse({ status: 200, bytes: audioBytes, contentType: "audio/mpeg" });

    const res = await sdk.audio.speech({
      model: "hexgrad/Kokoro-82M",
      input: "Hello world",
      voice: "af_bella",
      response_format: "mp3",
    });

    expect(res.contentType).toBe("audio/mpeg");
    expect(res.audio).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(res.audio)).toEqual(audioBytes);

    const r = api.lastRequest();
    expect(r.method).toBe("POST");
    expect(r.path).toBe("/api/v1/audio/speech");
    expect(r.auth).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(r.contentType).toContain("application/json");
    expect(r.json).toMatchObject({
      model: "hexgrad/Kokoro-82M",
      input: "Hello world",
      voice: "af_bella",
      response_format: "mp3",
    });
  });

  test("speech omits undefined optional fields from the payload", async () => {
    api.setResponse({ status: 200, bytes: new Uint8Array([1]), contentType: "audio/mpeg" });

    await sdk.audio.speech({ model: "m", input: "hi" });

    const r = api.lastRequest();
    const body = r.json as Record<string, unknown>;
    expect(body.model).toBe("m");
    expect(body.input).toBe("hi");
    expect(body).not.toHaveProperty("voice");
    expect(body).not.toHaveProperty("speed");
    expect(body).not.toHaveProperty("language");
    expect(body).not.toHaveProperty("response_format");
  });

  test("speech maps a 400 from the backend to BadRequestError", async () => {
    api.setResponse({
      status: 400,
      body: { error: "Model not audio-capable" },
      contentType: "application/json",
    });
    let thrown: unknown;
    try {
      await sdk.audio.speech({ model: "bad", input: "x" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestError);
    expect((thrown as BadRequestError).status).toBe(400);
  });

  test("speech rejects a 200 with a non-audio content-type instead of returning HTML bytes", async () => {
    // Gateway error page leaks through as a 200; without the content-type
    // guard the SDK would happily resolve `{ audio: <HTML>, contentType: 'text/html' }`.
    api.setResponse({
      status: 200,
      body: "<html>error</html>",
      contentType: "text/html",
    });
    let thrown: unknown;
    try {
      await sdk.audio.speech({ model: "m", input: "hi" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnifiedAIError);
    expect((thrown as UnifiedAIError).message).toContain("text/html");
  });

  test("speech rejects a 204 No Content rather than returning a 0-byte buffer", async () => {
    api.setResponse({ status: 204, body: "", contentType: "audio/mpeg" });
    let thrown: unknown;
    try {
      await sdk.audio.speech({ model: "m", input: "hi" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnifiedAIError);
    expect((thrown as UnifiedAIError).status).toBe(204);
  });

  test("speech surfaces a 500 as a UnifiedAIError (ServerError)", async () => {
    api.setResponse({
      status: 500,
      body: { message: "Audio model is not available" },
      contentType: "application/json",
    });
    let thrown: unknown;
    try {
      await sdk.audio.speech({ model: "m", input: "x" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(UnifiedAIError);
    expect((thrown as UnifiedAIError).status).toBe(500);
  });
});

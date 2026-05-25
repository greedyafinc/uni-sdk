import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TokenSet } from "../../src/core/_internal/tokens";
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
  rawBody: string;
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
    rawBody: "",
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
        rawBody: text,
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

const SAMPLE_IMAGE_RESPONSE = {
  created: 1700000000,
  data: [
    {
      b64_json: "AAAA",
      revised_prompt: "a fluffy cat",
      image_id: "img_123",
      signed_url: "https://example.com/img_123.webp",
    },
  ],
  usage: {
    input_tokens: 12,
    input_tokens_details: { image_tokens: 0, text_tokens: 12 },
    output_tokens: 256,
    total_tokens: 268,
  },
};

describe("sdk.images", () => {
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

  test("generate posts JSON to /api/v1/images/generations and parses the response", async () => {
    api.setResponse({ status: 200, body: SAMPLE_IMAGE_RESPONSE });
    const res = await sdk.images.generate({
      model: "gpt-image-1",
      prompt: "a fluffy cat",
      n: 1,
      size: "1024x1024",
      conversation_id: "conv_1",
    });
    expect(res.created).toBe(1700000000);
    expect(res.data?.[0]?.image_id).toBe("img_123");
    expect(res.data?.[0]?.signed_url).toBe("https://example.com/img_123.webp");

    const r = api.lastRequest();
    expect(r.method).toBe("POST");
    expect(r.path).toBe("/api/v1/images/generations");
    expect(r.auth).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(r.contentType).toContain("application/json");
    expect(r.json).toMatchObject({
      model: "gpt-image-1",
      prompt: "a fluffy cat",
      n: 1,
      size: "1024x1024",
      conversation_id: "conv_1",
    });
  });

  test("edit posts JSON with image references to /api/v1/images/edits", async () => {
    api.setResponse({ status: 200, body: SAMPLE_IMAGE_RESPONSE });
    await sdk.images.edit({
      model: "gpt-image-1",
      prompt: "add a hat",
      images: [{ file_id: "file_abc" }, { image_url: "https://example.com/cat.png" }],
      mask: { file_id: "file_mask" },
      size: "1024x1024",
      n: 2,
    });
    const r = api.lastRequest();
    expect(r.method).toBe("POST");
    expect(r.path).toBe("/api/v1/images/edits");
    expect(r.contentType).toContain("application/json");
    expect(r.json).toMatchObject({
      model: "gpt-image-1",
      prompt: "add a hat",
      images: [{ file_id: "file_abc" }, { image_url: "https://example.com/cat.png" }],
      mask: { file_id: "file_mask" },
      n: 2,
    });
  });

  test("createVariation posts multipart/form-data to /api/v1/images/variations", async () => {
    api.setResponse({ status: 200, body: SAMPLE_IMAGE_RESPONSE });
    const image = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
    await sdk.images.createVariation({
      image,
      filename: "source.png",
      n: 3,
      size: "512x512",
      conversation_id: "conv_2",
    });
    const r = api.lastRequest();
    expect(r.method).toBe("POST");
    expect(r.path).toBe("/api/v1/images/variations");
    expect(r.contentType).toContain("multipart/form-data");
    // The body should contain the multipart field markers and our values.
    expect(r.rawBody).toContain('name="image"');
    expect(r.rawBody).toContain("source.png");
    expect(r.rawBody).toContain('name="n"');
    expect(r.rawBody).toContain('name="size"');
    expect(r.rawBody).toContain("512x512");
    expect(r.rawBody).toContain('name="conversation_id"');
    expect(r.rawBody).toContain("conv_2");
  });

  test("createVariation omits optional fields when not provided", async () => {
    api.setResponse({ status: 200, body: SAMPLE_IMAGE_RESPONSE });
    const image = new Blob([new Uint8Array([0])], { type: "image/png" });
    await sdk.images.createVariation({ image });
    const r = api.lastRequest();
    expect(r.rawBody).toContain('name="image"');
    expect(r.rawBody).toContain("image.png");
    expect(r.rawBody).not.toContain('name="n"');
    expect(r.rawBody).not.toContain('name="size"');
    expect(r.rawBody).not.toContain('name="conversation_id"');
  });
});

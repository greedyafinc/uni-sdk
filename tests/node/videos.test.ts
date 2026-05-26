import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { TokenSet } from "../../src/core/_internal/tokens";
import { NotFoundError } from "../../src/core/errors";
import { InMemoryKeychain } from "../../src/node/_internal/keychain";
import { UnifiedAI } from "../../src/node/index";
import type { VideoObject } from "../../src/resources/videos";

const CLIENT = "app_test";
const USER = "user_test";
const ACCESS_TOKEN = "access_test";

type Responder = (req: Request, body: string) => Response | Promise<Response>;

interface CapturedRequest {
  path: string;
  method: string;
  contentType: string;
  rawBody: string;
  json: unknown;
}

interface FakeApi {
  baseUrl: string;
  stop: () => Promise<void>;
  /** Queue responses in arrival order. Last responder repeats. */
  setResponses: (responders: Responder[]) => void;
  requests: () => CapturedRequest[];
}

async function startFakeApi(): Promise<FakeApi> {
  let queue: Responder[] = [];
  const captured: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      const text = await req.text();
      let parsed: unknown;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
      }
      captured.push({
        path: url.pathname,
        method: req.method,
        contentType: req.headers.get("content-type") ?? "",
        rawBody: text,
        json: parsed,
      });
      const r = queue.length > 1 ? queue.shift() : queue[0];
      if (!r) {
        return new Response(JSON.stringify({ error: "no responder" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return r(req, text);
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      await server.stop(true);
    },
    setResponses: (rs) => {
      queue = rs.slice();
    },
    requests: () => captured.slice(),
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

const OP_NAME =
  "projects/proj-x/locations/us-central1/publishers/google/models/veo-3.1-lite-generate-001/operations/op-abc/123";

function videoObject(overrides: Partial<VideoObject> = {}): VideoObject {
  return {
    id: OP_NAME,
    object: "video",
    model: "veo-3.1-lite-generate-001",
    status: "queued",
    progress: 0,
    created_at: 1_700_000_000,
    completed_at: null,
    expires_at: null,
    seconds: "4",
    size: "1280x720",
    error: null,
    remixed_from_video_id: null,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("sdk.videos", () => {
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

  test("create posts multipart/form-data to /api/v1/videos even without input_reference", async () => {
    api.setResponses([() => jsonResponse(200, videoObject({ status: "queued" }))]);

    const v = await sdk.videos.create({
      prompt: "a cat dancing",
      model: "veo-3.1-lite-generate-001",
      seconds: "4",
      size: "1280x720",
      generate_audio: true,
    });
    expect(v.id).toBe(OP_NAME);
    expect(v.status).toBe("queued");

    const r = api.requests()[0] as CapturedRequest;
    expect(r.method).toBe("POST");
    expect(r.path).toBe("/api/v1/videos");
    // Standardized on multipart so we match what unified-api actually tests
    // server-side (its JSON path is uncovered and likely fragile w/ t.File).
    expect(r.contentType).toContain("multipart/form-data");
    expect(r.rawBody).toContain('name="prompt"');
    expect(r.rawBody).toContain("a cat dancing");
    expect(r.rawBody).toContain('name="model"');
    expect(r.rawBody).toContain("veo-3.1-lite-generate-001");
    expect(r.rawBody).toContain('name="seconds"');
    expect(r.rawBody).toContain('name="size"');
    expect(r.rawBody).toContain('name="generate_audio"');
    expect(r.rawBody).toContain("true");
    // No input_reference field when none is provided.
    expect(r.rawBody).not.toContain('name="input_reference"');
  });

  test("create posts multipart/form-data when input_reference is provided", async () => {
    api.setResponses([() => jsonResponse(200, videoObject())]);

    const reference = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
    await sdk.videos.create({
      prompt: "animate this",
      model: "veo-3.1-lite-generate-001",
      input_reference: reference,
      input_reference_filename: "ref.png",
      seconds: "6",
      generate_audio: false,
    });

    const r = api.requests()[0] as CapturedRequest;
    expect(r.contentType).toContain("multipart/form-data");
    expect(r.rawBody).toContain('name="prompt"');
    expect(r.rawBody).toContain("animate this");
    expect(r.rawBody).toContain('name="input_reference"');
    expect(r.rawBody).toContain("ref.png");
    expect(r.rawBody).toContain('name="seconds"');
    expect(r.rawBody).toContain('name="generate_audio"');
    expect(r.rawBody).toContain("false");
  });

  test("retrieve URL-encodes the operation name into the path", async () => {
    api.setResponses([() => jsonResponse(200, videoObject({ status: "in_progress" }))]);

    await sdk.videos.retrieve(OP_NAME);
    const r = api.requests()[0] as CapturedRequest;
    expect(r.method).toBe("GET");
    expect(r.path).toBe(`/api/v1/videos/${encodeURIComponent(OP_NAME)}`);
    // Slashes in the operation name must NOT survive as path separators.
    expect(r.path.includes("/operations/")).toBe(false);
  });

  test("content returns the raw mp4 bytes with mimeType", async () => {
    const mp4 = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]); // ftyp magic
    api.setResponses([
      () =>
        new Response(mp4, {
          status: 200,
          headers: { "content-type": "video/mp4" },
        }),
    ]);

    const out = await sdk.videos.content(OP_NAME);
    expect(out.mimeType).toBe("video/mp4");
    expect(new Uint8Array(out.bytes)).toEqual(mp4);

    const r = api.requests()[0] as CapturedRequest;
    expect(r.path).toBe(`/api/v1/videos/${encodeURIComponent(OP_NAME)}/content`);
  });

  test("content propagates the server-reported mime type unchanged", async () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    api.setResponses([
      () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "video/webm" },
        }),
    ]);
    const out = await sdk.videos.content(OP_NAME);
    expect(out.mimeType).toBe("video/webm");
  });

  test("retrieve surfaces a 404 as NotFoundError", async () => {
    api.setResponses([() => jsonResponse(404, { error: "video not found" })]);
    let thrown: unknown;
    try {
      await sdk.videos.retrieve(OP_NAME);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(NotFoundError);
  });

  test("waitUntilReady polls until status is completed", async () => {
    api.setResponses([
      () => jsonResponse(200, videoObject({ status: "queued" })),
      () => jsonResponse(200, videoObject({ status: "in_progress", progress: 50 })),
      () => jsonResponse(200, videoObject({ status: "completed", progress: 100 })),
    ]);

    const v = await sdk.videos.waitUntilReady(OP_NAME, {
      pollIntervalMs: 1,
      timeoutMs: 10_000,
    });
    expect(v.status).toBe("completed");
    expect(api.requests().length).toBe(3);
  });

  test("waitUntilReady returns a failed VideoObject without throwing", async () => {
    api.setResponses([
      () =>
        jsonResponse(
          200,
          videoObject({
            status: "failed",
            error: { code: "content_policy", message: "rejected" },
          }),
        ),
    ]);
    const v = await sdk.videos.waitUntilReady(OP_NAME, { pollIntervalMs: 1 });
    expect(v.status).toBe("failed");
    expect(v.error?.code).toBe("content_policy");
  });

  test("waitUntilReady checks deadline before issuing the next retrieve", async () => {
    // Simulate a slow retrieve (each call takes ~30ms). With timeoutMs=20 the
    // pre-retrieve deadline guard must fire on iteration 2 BEFORE the second
    // network call; otherwise we'd burn an extra request past the user's
    // requested deadline.
    let calls = 0;
    api.setResponses([
      async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 30));
        return jsonResponse(200, videoObject({ status: "in_progress" }));
      },
    ]);
    const start = Date.now();
    let thrown: unknown;
    try {
      await sdk.videos.waitUntilReady(OP_NAME, { pollIntervalMs: 1, timeoutMs: 20 });
    } catch (e) {
      thrown = e;
    }
    const elapsed = Date.now() - start;
    expect(thrown).toBeInstanceOf(Error);
    // Exactly one retrieve happens (the first one, at t=0 < deadline=20);
    // by the time it returns at t≈30 the next iter's pre-check trips.
    expect(calls).toBe(1);
    // Should not exceed one retrieve's worth of latency past the timeout.
    expect(elapsed).toBeLessThan(80);
  });

  test("waitUntilReady throws on timeout", async () => {
    api.setResponses([() => jsonResponse(200, videoObject({ status: "in_progress" }))]);
    let thrown: unknown;
    try {
      await sdk.videos.waitUntilReady(OP_NAME, { pollIntervalMs: 1, timeoutMs: 5 });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("did not reach a terminal state");
  });

  test("waitUntilReady aborts when the signal fires", async () => {
    api.setResponses([() => jsonResponse(200, videoObject({ status: "in_progress" }))]);
    const ac = new AbortController();
    const p = sdk.videos.waitUntilReady(OP_NAME, {
      pollIntervalMs: 50,
      signal: ac.signal,
    });
    // Abort after the first poll has been issued.
    setTimeout(() => ac.abort(), 10);
    let thrown: unknown;
    try {
      await p;
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect((thrown as Error).name).toBe("AbortError");
  });
});

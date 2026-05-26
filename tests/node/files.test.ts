import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
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
  rawBody: Buffer;
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
    rawBody: Buffer.alloc(0),
  };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      const bytes = Buffer.from(await req.arrayBuffer());
      last = {
        path: url.pathname,
        method: req.method,
        auth: req.headers.get("authorization") ?? "",
        contentType: req.headers.get("content-type") ?? "",
        rawBody: bytes,
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

// Helper: pull out a named part header from the multipart body. Returns the
// header bytes (everything between this part's boundary and the blank line
// terminating its headers).
function extractPart(body: Buffer, name: string): { headers: string; payload: Buffer } | null {
  const text = body.toString("binary");
  const marker = `name="${name}"`;
  const i = text.indexOf(marker);
  if (i < 0) return null;
  // Walk back to the start of this part's headers (after the preceding boundary).
  const headerStart = text.lastIndexOf("\r\n", i) + 2;
  const headerEnd = text.indexOf("\r\n\r\n", i);
  if (headerEnd < 0) return null;
  const payloadStart = headerEnd + 4;
  // The payload ends at "\r\n--<boundary>"; find the next boundary marker.
  const nextBoundary = text.indexOf("\r\n--", payloadStart);
  const payloadEnd = nextBoundary < 0 ? body.length : nextBoundary;
  return {
    headers: text.slice(headerStart, headerEnd),
    payload: body.subarray(payloadStart, payloadEnd),
  };
}

// Minimal 1x1 transparent PNG.
const PNG_1X1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c,
  0x02, 0x00, 0x00, 0x00, 0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const SAMPLE_UPLOAD_RESPONSE = {
  file_id: "file_abc123",
  image_url: "https://signed.example.com/file_abc123.png?token=xyz",
  expires_at: "2026-05-26T16:00:00Z",
};

describe("sdk.files", () => {
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

  test("upload posts multipart/form-data to /api/v1/images/uploads from a Blob", async () => {
    api.setResponse({ status: 200, body: SAMPLE_UPLOAD_RESPONSE });
    const blob = new Blob([PNG_1X1], { type: "image/png" });
    const res = await sdk.files.upload(blob, { filename: "source.png" });

    expect(res.file_id).toBe("file_abc123");
    expect(res.image_url).toContain("signed.example.com");
    expect(res.expires_at).toBeDefined();

    const r = api.lastRequest();
    expect(r.method).toBe("POST");
    expect(r.path).toBe("/api/v1/images/uploads");
    expect(r.auth).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(r.contentType).toContain("multipart/form-data");

    const part = extractPart(r.rawBody, "file");
    expect(part).not.toBeNull();
    expect(part?.headers).toContain('filename="source.png"');
    expect(part?.headers.toLowerCase()).toContain("content-type: image/png");
    expect(part?.payload.equals(PNG_1X1)).toBe(true);
  });

  test("upload accepts a Uint8Array with explicit content-type", async () => {
    api.setResponse({ status: 200, body: SAMPLE_UPLOAD_RESPONSE });
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // jpeg-ish
    await sdk.files.upload(bytes, { filename: "raw.jpg", contentType: "image/jpeg" });
    const r = api.lastRequest();
    expect(r.contentType).toContain("multipart/form-data");
    const part = extractPart(r.rawBody, "file");
    expect(part?.headers).toContain('filename="raw.jpg"');
    expect(part?.headers.toLowerCase()).toContain("content-type: image/jpeg");
    expect(part?.payload.equals(Buffer.from(bytes))).toBe(true);
  });

  test("upload sniffs PNG magic bytes when no contentType is provided", async () => {
    api.setResponse({ status: 200, body: SAMPLE_UPLOAD_RESPONSE });
    // Pass raw PNG bytes as a plain Uint8Array (typical fs.readFileSync result).
    await sdk.files.upload(new Uint8Array(PNG_1X1));
    const r = api.lastRequest();
    const part = extractPart(r.rawBody, "file");
    expect(part?.headers.toLowerCase()).toContain("content-type: image/png");
    // Default filename derived from the sniffed mime.
    expect(part?.headers).toContain('filename="upload.png"');
    expect(part?.payload.equals(PNG_1X1)).toBe(true);
  });

  test("upload sniffs PNG magic bytes when Blob.type is empty", async () => {
    api.setResponse({ status: 200, body: SAMPLE_UPLOAD_RESPONSE });
    // Typed-less Blob (e.g. clipboard paste or drag-drop).
    const blob = new Blob([PNG_1X1]);
    expect(blob.type).toBe("");
    await sdk.files.upload(blob);
    const r = api.lastRequest();
    const part = extractPart(r.rawBody, "file");
    expect(part?.headers.toLowerCase()).toContain("content-type: image/png");
    expect(part?.headers).toContain('filename="upload.png"');
  });

  test("upload accepts a Node Buffer (Uint8Array subclass)", async () => {
    api.setResponse({ status: 200, body: SAMPLE_UPLOAD_RESPONSE });
    await sdk.files.upload(Buffer.from(PNG_1X1), { filename: "buf.png" });
    const r = api.lastRequest();
    const part = extractPart(r.rawBody, "file");
    expect(part?.headers).toContain('filename="buf.png"');
    // No contentType passed and buf.png isn't used for sniffing; magic bytes
    // resolve to PNG.
    expect(part?.headers.toLowerCase()).toContain("content-type: image/png");
    expect(part?.payload.equals(PNG_1X1)).toBe(true);
  });

  test("upload accepts a base64 data URL and derives the mime", async () => {
    api.setResponse({ status: 200, body: SAMPLE_UPLOAD_RESPONSE });
    const pngB64 = PNG_1X1.toString("base64");
    await sdk.files.upload(`data:image/png;base64,${pngB64}`);
    const r = api.lastRequest();
    const part = extractPart(r.rawBody, "file");
    expect(part?.headers).toContain('filename="upload.png"');
    expect(part?.headers.toLowerCase()).toContain("content-type: image/png");
    expect(part?.payload.equals(PNG_1X1)).toBe(true);
  });

  test("upload tolerates whitespace in base64 data URLs (pretty-printed encoders)", async () => {
    api.setResponse({ status: 200, body: SAMPLE_UPLOAD_RESPONSE });
    // Insert newlines every 16 chars (mimics openssl base64 / PEM output).
    const wrapped = PNG_1X1.toString("base64").replace(/(.{16})/g, "$1\n");
    await sdk.files.upload(`data:image/png;base64,${wrapped}`);
    const r = api.lastRequest();
    const part = extractPart(r.rawBody, "file");
    expect(part?.payload.equals(PNG_1X1)).toBe(true);
  });

  test("upload sniffs mime when data URL omits its mime", async () => {
    api.setResponse({ status: 200, body: SAMPLE_UPLOAD_RESPONSE });
    const pngB64 = PNG_1X1.toString("base64");
    // RFC 2397 valid: no mime, just `;base64`.
    await sdk.files.upload(`data:;base64,${pngB64}`);
    const r = api.lastRequest();
    const part = extractPart(r.rawBody, "file");
    expect(part?.headers.toLowerCase()).toContain("content-type: image/png");
  });

  test("upload defaults filename to the File's name when not overridden", async () => {
    api.setResponse({ status: 200, body: SAMPLE_UPLOAD_RESPONSE });
    const file = new File([PNG_1X1], "user-picked.png", { type: "image/png" });
    await sdk.files.upload(file);
    const r = api.lastRequest();
    const part = extractPart(r.rawBody, "file");
    expect(part?.headers).toContain('filename="user-picked.png"');
    expect(part?.headers.toLowerCase()).toContain("content-type: image/png");
  });

  test("upload rejects hosted URL strings", async () => {
    await expect(sdk.files.upload("https://example.com/cat.png")).rejects.toThrow(
      /base64 data URL/,
    );
  });

  test("upload rejects non-base64 data URLs", async () => {
    await expect(sdk.files.upload("data:text/plain,hello")).rejects.toThrow(/base64-encoded/);
  });

  test("upload rejects { fileId } with a targeted message", async () => {
    const bad = { fileId: "file_x" } as unknown as Blob;
    await expect(sdk.files.upload(bad)).rejects.toThrow(/fileId is the OUTPUT of upload/);
  });

  test("upload rejects { url } with a targeted message", async () => {
    const bad = { url: "https://example.com/a.png" } as unknown as Blob;
    await expect(sdk.files.upload(bad)).rejects.toThrow(/hosted URLs cannot be re-uploaded/);
  });

  test("upload rejects { data, mimeType } with a targeted message", async () => {
    const bad = { data: "AAAA", mimeType: "image/png" } as unknown as Blob;
    await expect(sdk.files.upload(bad)).rejects.toThrow(/base64 data URL string/);
  });

  test("upload rejects overlapping object transports", async () => {
    const bad = { url: "https://x", fileId: "file_y" } as unknown as Blob;
    await expect(sdk.files.upload(bad)).rejects.toThrow(/overlapping transports/);
  });

  test("upload rejects fetch Response", async () => {
    const res = new Response(PNG_1X1) as unknown as Blob;
    await expect(sdk.files.upload(res)).rejects.toThrow(/fetch Response/);
  });

  test("upload rejects unsupported sources", async () => {
    await expect(sdk.files.upload(42 as unknown as Blob)).rejects.toThrow(
      /unsupported file source/,
    );
  });

  test("upload honors a pre-aborted signal without making a request", async () => {
    api.setResponse({ status: 200, body: SAMPLE_UPLOAD_RESPONSE });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      sdk.files.upload(PNG_1X1, { filename: "x.png", signal: ctrl.signal }),
    ).rejects.toThrow(/aborted/);
    expect(api.lastRequest().path).toBe(""); // server never received anything
  });
});

// ── 401-refresh during multipart upload ────────────────────────────────────
//
// Regression guard for a subtle interaction: client.ts captures the FormData
// body once into `bodyInit` and reuses it across both the initial send and
// the post-refresh retry. FormData parts backed by in-memory Blobs are
// reusable, but a future change to streaming uploads could silently break
// this — the retry would send 0 bytes. This test exercises the path against
// a real Bun HTTP server and asserts the second request carries the exact
// same multipart payload as the first.
describe("sdk.files — 401 refresh", () => {
  test("multipart body survives a 401 → refresh → retry cycle", async () => {
    let requestNum = 0;
    const captured: Array<{ auth: string; body: Buffer; contentType: string }> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const bytes = Buffer.from(await req.arrayBuffer());
        captured.push({
          auth: req.headers.get("authorization") ?? "",
          body: bytes,
          contentType: req.headers.get("content-type") ?? "",
        });
        requestNum += 1;
        if (requestNum === 1) return new Response("unauthorized", { status: 401 });
        return new Response(
          JSON.stringify({
            file_id: "file_after_refresh",
            image_url: "https://x.example.com/y.png",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    try {
      // Trusted-token mode: callback is invoked on first request AND on
      // 401-retry (the SDK calls it again to let the host rotate the token).
      let tokenCallCount = 0;
      const sdk = new UnifiedAI({
        apiUrl: `http://127.0.0.1:${server.port}`,
        token: async () => {
          tokenCallCount += 1;
          return tokenCallCount === 1 ? "stale-token" : "fresh-token";
        },
      });

      const res = await sdk.files.upload(PNG_1X1, {
        filename: "retry.png",
        contentType: "image/png",
      });
      expect(res.file_id).toBe("file_after_refresh");

      // The server saw exactly two requests.
      expect(captured.length).toBe(2);

      // First carried the stale token (which got 401'd), second carried the
      // freshly-fetched token from the callback.
      expect(captured[0]?.auth).toBe("Bearer stale-token");
      expect(captured[1]?.auth).toBe("Bearer fresh-token");

      // Both multipart bodies are non-empty AND byte-identical (modulo
      // boundary string, which Bun's FormData regenerates per request).
      expect(captured[0]?.body.length).toBeGreaterThan(0);
      expect(captured[1]?.body.length).toBeGreaterThan(0);
      // The PNG payload bytes must appear in both — this is the load-bearing
      // assertion. If FormData got consumed on the first send, the retry
      // would be 0 bytes or missing the file part.
      expect(captured[0]?.body.includes(PNG_1X1)).toBe(true);
      expect(captured[1]?.body.includes(PNG_1X1)).toBe(true);

      // Both content-types are multipart with a boundary.
      expect(captured[0]?.contentType).toMatch(/^multipart\/form-data; boundary=/);
      expect(captured[1]?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    } finally {
      await server.stop(true);
    }
  });
});

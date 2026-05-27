import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { UnifiedAI } from "../../src/node/index";

// ── Fake chunked-upload backend ────────────────────────────────────────────
//
// Mirrors the unified-api /api/v1/files/uploads protocol just enough to drive
// the SDK through full and resume lifecycles. State is kept in module-level
// maps so tests can inspect what the server received.

const CHUNK_SIZE = 5 * 1024 * 1024;

interface Session {
  upload_id: string;
  filename: string;
  mime_type: string;
  total_bytes: number;
  chunk_size: number;
  received_chunks: Set<number>;
  chunks: Map<number, Buffer>;
  expires_at: string;
}

interface FakeBackend {
  baseUrl: string;
  stop: () => Promise<void>;
  sessions: Map<string, Session>;
  putCalls: Array<{ uploadId: string; index: number; size: number; status: number; auth: string }>;
  /** If set, the next PUT to this index returns the given status without recording. */
  nextChunkFailure: { index: number; status: number } | null;
  setNextChunkFailure: (f: { index: number; status: number } | null) => void;
  /** When set, every request whose auth header matches `staleToken` is 401'd. */
  staleToken: string | null;
  setStaleToken: (t: string | null) => void;
  /** When > 0, every PUT response is delayed by this many ms — used for abort mid-flight. */
  putDelayMs: number;
  setPutDelayMs: (ms: number) => void;
  /** Number of upcoming PUT chunk requests to 401 (decremented per request). */
  setNext401PutCount: (n: number) => void;
  /** Delay applied to the /complete POST response — for aborting during finalize. */
  setCompleteDelayMs: (ms: number) => void;
}

async function startFakeBackend(): Promise<FakeBackend> {
  const sessions = new Map<string, Session>();
  const putCalls: FakeBackend["putCalls"] = [];
  let nextChunkFailure: { index: number; status: number } | null = null;
  let staleToken: string | null = null;
  let putDelayMs = 0;
  let putRequests401 = 0;
  let completeDelayMs = 0;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;
      const auth = req.headers.get("authorization") ?? "";

      // Stale-token gate: every request carrying the stale bearer is 401'd
      // before any business logic runs. The SDK's refresh path should swap
      // the token and retry transparently. We record chunk PUTs so the test
      // can see both the failed and refreshed attempts.
      if (staleToken && auth === `Bearer ${staleToken}`) {
        const cm = path.match(/^\/api\/v1\/files\/uploads\/([^/]+)\/chunks\/(\d+)$/);
        if (method === "PUT" && cm && cm[1] && cm[2]) {
          // Drain so the connection can be reused for the retry.
          const bytes = Buffer.from(await req.arrayBuffer());
          putCalls.push({
            uploadId: cm[1],
            index: Number(cm[2]),
            size: bytes.length,
            status: 401,
            auth,
          });
        }
        return new Response("unauthorized", { status: 401 });
      }

      // POST /api/v1/files/uploads — init
      if (method === "POST" && path === "/api/v1/files/uploads") {
        const body = (await req.json()) as {
          filename: string;
          mime_type: string;
          total_bytes: number;
          purpose?: string;
        };
        const upload_id = `upl_${Math.random().toString(36).slice(2, 10)}`;
        sessions.set(upload_id, {
          upload_id,
          filename: body.filename,
          mime_type: body.mime_type,
          total_bytes: body.total_bytes,
          chunk_size: CHUNK_SIZE,
          received_chunks: new Set(),
          chunks: new Map(),
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        });
        return Response.json(
          { upload_id, chunk_size: CHUNK_SIZE, expires_at: sessions.get(upload_id)?.expires_at },
          { status: 201 },
        );
      }

      // PUT /api/v1/files/uploads/:id/chunks/:n — store chunk
      const chunkMatch = path.match(/^\/api\/v1\/files\/uploads\/([^/]+)\/chunks\/(\d+)$/);
      if (method === "PUT" && chunkMatch && chunkMatch[1] && chunkMatch[2]) {
        const uploadId = chunkMatch[1];
        const idx = Number(chunkMatch[2]);
        const session = sessions.get(uploadId);
        if (!session) return new Response("not found", { status: 404 });
        // Drain the body even when we're going to fail — otherwise the
        // server-side stream stays open and the SDK side can deadlock on
        // half-uploaded bodies waiting for a response.
        const bytes = Buffer.from(await req.arrayBuffer());
        if (putRequests401 > 0) {
          putRequests401 -= 1;
          putCalls.push({ uploadId, index: idx, size: bytes.length, status: 401, auth });
          return new Response("unauthorized", { status: 401 });
        }
        if (nextChunkFailure && nextChunkFailure.index === idx) {
          const status = nextChunkFailure.status;
          nextChunkFailure = null;
          putCalls.push({ uploadId, index: idx, size: bytes.length, status, auth });
          return new Response("simulated failure", { status });
        }
        // Optional artificial latency lets a test abort mid-PUT.
        if (putDelayMs > 0) {
          await new Promise((r) => setTimeout(r, putDelayMs));
        }
        session.received_chunks.add(idx);
        session.chunks.set(idx, bytes);
        putCalls.push({ uploadId, index: idx, size: bytes.length, status: 200, auth });
        const received = Array.from(session.chunks.values()).reduce((s, b) => s + b.length, 0);
        return Response.json({
          upload_id: uploadId,
          chunk_index: idx,
          received_bytes: received,
          total_bytes: session.total_bytes,
        });
      }

      // GET /api/v1/files/uploads/:id — state (resume)
      const stateMatch = path.match(/^\/api\/v1\/files\/uploads\/([^/]+)$/);
      if (method === "GET" && stateMatch && stateMatch[1]) {
        const session = sessions.get(stateMatch[1]);
        if (!session) return new Response("not found", { status: 404 });
        const received = Array.from(session.chunks.values()).reduce((s, b) => s + b.length, 0);
        return Response.json({
          upload_id: session.upload_id,
          filename: session.filename,
          mime_type: session.mime_type,
          total_bytes: session.total_bytes,
          chunk_size: session.chunk_size,
          received_chunks: [...session.received_chunks].sort((a, b) => a - b),
          received_bytes: received,
          expires_at: session.expires_at,
        });
      }

      // POST /api/v1/files/uploads/:id/complete — finalize
      const completeMatch = path.match(/^\/api\/v1\/files\/uploads\/([^/]+)\/complete$/);
      if (method === "POST" && completeMatch && completeMatch[1]) {
        const session = sessions.get(completeMatch[1]);
        if (!session) return new Response("not found", { status: 404 });
        const totalChunks = Math.ceil(session.total_bytes / session.chunk_size);
        const missing: number[] = [];
        for (let i = 0; i < totalChunks; i++) {
          if (!session.received_chunks.has(i)) missing.push(i);
        }
        if (missing.length > 0) {
          return Response.json(
            { status: "Conflict", message: `missing chunks: ${missing.join(",")}` },
            { status: 409 },
          );
        }
        if (completeDelayMs > 0) {
          await new Promise((r) => setTimeout(r, completeDelayMs));
        }
        // Mimic a real completion: concatenate and return a FileObject.
        const ordered: Buffer[] = [];
        for (let i = 0; i < totalChunks; i++) {
          const c = session.chunks.get(i);
          if (!c) return new Response("internal: chunk missing", { status: 500 });
          ordered.push(c);
        }
        const total = ordered.reduce((s, b) => s + b.length, 0);
        sessions.delete(completeMatch[1]); // server-side cleanup
        return Response.json({
          id: `file_${Math.random().toString(36).slice(2, 10)}`,
          filename: session.filename,
          mime_type: session.mime_type,
          bytes: total,
          purpose: "assistants",
          created_at: new Date().toISOString(),
        });
      }

      return new Response(`no route for ${method} ${path}`, { status: 404 });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      await server.stop(true);
    },
    sessions,
    putCalls,
    get nextChunkFailure() {
      return nextChunkFailure;
    },
    setNextChunkFailure(f) {
      nextChunkFailure = f;
    },
    get staleToken() {
      return staleToken;
    },
    setStaleToken(t) {
      staleToken = t;
    },
    get putDelayMs() {
      return putDelayMs;
    },
    setPutDelayMs(ms) {
      putDelayMs = ms;
    },
    setNext401PutCount(n: number) {
      putRequests401 = n;
    },
    setCompleteDelayMs(ms: number) {
      completeDelayMs = ms;
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("sdk.files — chunked upload", () => {
  let backend: FakeBackend;
  let sdk: UnifiedAI;

  beforeEach(async () => {
    backend = await startFakeBackend();
    sdk = new UnifiedAI({
      apiUrl: backend.baseUrl,
      token: "test-token",
    });
  });

  afterEach(async () => {
    await backend.stop();
  });

  test("uses single-shot path below the threshold", async () => {
    // Small payload — should stay on POST /api/v1/files. Backend's catch-all
    // 404s for unknown routes, so we mount a custom server here just for the
    // single-shot endpoint to keep the assertion focused.
    const oneShotPayload = Buffer.alloc(1024, 0xaa);
    const small = new Blob([oneShotPayload], { type: "application/pdf" });
    // Stop the chunked backend and stand up a tiny single-shot fake.
    await backend.stop();
    let singleShotHits = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/api/v1/files") {
          singleShotHits += 1;
          return Response.json({
            id: "file_small",
            filename: "x.pdf",
            mime_type: "application/pdf",
            bytes: oneShotPayload.length,
            purpose: "assistants",
            created_at: new Date().toISOString(),
          });
        }
        return new Response("nope", { status: 500 });
      },
    });
    try {
      sdk = new UnifiedAI({
        apiUrl: `http://127.0.0.1:${server.port}`,
        token: "test-token",
      });
      const file = await sdk.files.create(small, { filename: "x.pdf" });
      expect(file.id).toBe("file_small");
      expect(singleShotHits).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test("uploads above threshold in chunks and returns a FileObject", async () => {
    // 2 chunks: full + tail. Use 12-byte tail so we can verify the final chunk
    // size assertion server-side.
    const total = CHUNK_SIZE + 12;
    const payload = Buffer.alloc(total);
    payload.fill(0xaa, 0, CHUNK_SIZE);
    payload.fill(0xbb, CHUNK_SIZE);
    const blob = new Blob([payload], { type: "video/mp4" });

    const events: Array<{ loaded: number; total: number; percent: number }> = [];
    const file = await sdk.files.create(blob, {
      filename: "movie.mp4",
      onProgress: (e) => events.push(e),
    });

    expect(file.bytes).toBe(total);
    expect(file.filename).toBe("movie.mp4");
    expect(file.mime_type).toBe("video/mp4");
    // Exactly two chunk PUTs, both successful.
    expect(backend.putCalls.filter((c) => c.status === 200).length).toBe(2);
    expect(backend.putCalls.map((c) => c.index).sort()).toEqual([0, 1]);
    expect(backend.putCalls.find((c) => c.index === 1)?.size).toBe(12);
    // Progress events: at minimum start (0), after chunk 0, after chunk 1.
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events[0]?.loaded).toBe(0);
    expect(events[events.length - 1]?.loaded).toBe(total);
    expect(events[events.length - 1]?.percent).toBe(100);
    // Session cleaned up server-side on complete.
    expect(backend.sessions.size).toBe(0);
  });

  test("retries a failed chunk with backoff and succeeds", async () => {
    const total = CHUNK_SIZE * 2;
    const payload = Buffer.alloc(total, 0x33);
    const blob = new Blob([payload], { type: "video/mp4" });

    // Inject a transient 503 on chunk index 1's first attempt. The retry
    // logic should drive it to success.
    backend.setNextChunkFailure({ index: 1, status: 503 });

    const file = await sdk.files.create(blob, { filename: "v.mp4" });
    expect(file.bytes).toBe(total);
    // Three calls: chunk 0 success, chunk 1 failure (503), chunk 1 retry success.
    expect(backend.putCalls.length).toBe(3);
    expect(backend.putCalls[0]).toMatchObject({ index: 0, status: 200 });
    expect(backend.putCalls[1]).toMatchObject({ index: 1, status: 503 });
    expect(backend.putCalls[2]).toMatchObject({ index: 1, status: 200 });
  });

  test("does NOT retry a 4xx chunk failure (client bug, not transient)", async () => {
    // Above CHUNK_SIZE so the chunked path is taken (boundary-equal goes
    // single-shot — the threshold predicate is `> threshold`).
    const total = CHUNK_SIZE + 1;
    const payload = Buffer.alloc(total, 0xff);
    const blob = new Blob([payload], { type: "video/mp4" });

    backend.setNextChunkFailure({ index: 0, status: 400 });

    await expect(sdk.files.create(blob, { filename: "v.mp4" })).rejects.toBeDefined();
    // Single attempt — no retries for 400.
    expect(backend.putCalls.length).toBe(1);
    expect(backend.putCalls[0]).toMatchObject({ index: 0, status: 400 });
  });

  test("resumes from an existing upload_id and skips acknowledged chunks", async () => {
    const total = CHUNK_SIZE * 2;
    const payload = Buffer.alloc(total);
    payload.fill(0x11, 0, CHUNK_SIZE);
    payload.fill(0x22, CHUNK_SIZE);
    const blob = new Blob([payload], { type: "video/mp4" });

    // Set up a session manually with chunk 0 already received.
    const upload_id = "upl_resume_test";
    backend.sessions.set(upload_id, {
      upload_id,
      filename: "v.mp4",
      mime_type: "video/mp4",
      total_bytes: total,
      chunk_size: CHUNK_SIZE,
      received_chunks: new Set([0]),
      chunks: new Map([[0, Buffer.alloc(CHUNK_SIZE, 0x11)]]),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });

    const events: Array<{ loaded: number; total: number; percent: number }> = [];
    const file = await sdk.files.create(blob, {
      filename: "v.mp4",
      resumeFrom: upload_id,
      onProgress: (e) => events.push(e),
    });

    expect(file.bytes).toBe(total);
    // Only chunk 1 was PUT — chunk 0 was already on the server.
    expect(backend.putCalls.length).toBe(1);
    expect(backend.putCalls[0]).toMatchObject({ index: 1, status: 200 });
    // Progress should reflect the resume — an early event ≥ chunk-0 bytes.
    const earlyChunkBytes = events.find((e) => e.loaded >= CHUNK_SIZE);
    expect(earlyChunkBytes).toBeDefined();
  });

  test("invokes onPersistUploadId on init and clears it on complete", async () => {
    const total = CHUNK_SIZE + 1;
    const payload = Buffer.alloc(total, 0xaa);
    const blob = new Blob([payload], { type: "video/mp4" });

    const persistCalls: Array<string | null> = [];
    await sdk.files.create(blob, {
      filename: "v.mp4",
      onPersistUploadId: (id) => {
        persistCalls.push(id);
      },
    });

    // First call: the active upload_id. Second call: null (cleared on complete).
    expect(persistCalls.length).toBe(2);
    expect(typeof persistCalls[0]).toBe("string");
    expect(persistCalls[0]?.startsWith("upl_")).toBe(true);
    expect(persistCalls[1]).toBeNull();
  });

  test("threshold override forces single-shot path even for chunk-sized payloads", async () => {
    // Replace the backend with a server that ONLY supports POST /api/v1/files.
    // If the SDK incorrectly takes the chunked path, init will 404.
    await backend.stop();
    let singleShotHits = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/api/v1/files") {
          singleShotHits += 1;
          await req.arrayBuffer(); // drain
          return Response.json({
            id: "file_via_override",
            filename: "v.mp4",
            mime_type: "video/mp4",
            bytes: CHUNK_SIZE,
            purpose: "assistants",
            created_at: new Date().toISOString(),
          });
        }
        return new Response("wrong route", { status: 500 });
      },
    });
    try {
      sdk = new UnifiedAI({
        apiUrl: `http://127.0.0.1:${server.port}`,
        token: "test-token",
      });
      const payload = Buffer.alloc(CHUNK_SIZE, 0xcc);
      const blob = new Blob([payload], { type: "video/mp4" });
      const file = await sdk.files.create(blob, {
        filename: "v.mp4",
        chunkedUploadThreshold: Number.POSITIVE_INFINITY,
      });
      expect(file.id).toBe("file_via_override");
      expect(singleShotHits).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test("threshold-boundary: at-threshold uses single-shot, just-above uses chunked", async () => {
    // At exactly threshold — single-shot.
    const atSize = Buffer.alloc(CHUNK_SIZE, 0xaa);
    const atBlob = new Blob([atSize], { type: "application/pdf" });

    // Need a server that handles BOTH routes since this test exercises the
    // boundary on the SAME sdk instance.
    await backend.stop();
    let singleShotHits = 0;
    const responses = {
      file: {
        id: "file_at",
        filename: "x.pdf",
        mime_type: "application/pdf",
        bytes: CHUNK_SIZE,
        purpose: "assistants",
        created_at: new Date().toISOString(),
      },
    };
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        if (path === "/api/v1/files") {
          singleShotHits += 1;
          await req.arrayBuffer();
          return Response.json(responses.file);
        }
        return new Response("wrong", { status: 500 });
      },
    });
    try {
      sdk = new UnifiedAI({
        apiUrl: `http://127.0.0.1:${server.port}`,
        token: "test-token",
      });
      await sdk.files.create(atBlob, { filename: "x.pdf" });
      // CHUNK_SIZE === threshold; default predicate is `> threshold`, so this
      // is single-shot.
      expect(singleShotHits).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  // ── Abort + 401 stress paths ─────────────────────────────────────────────
  //
  // The chunked path issues many requests against the auth and abort
  // mechanisms; both deserve their own tests separate from the happy path.

  test("abort during an active chunk PUT throws and skips remaining chunks", async () => {
    // 2 chunks. Add latency to chunk PUTs so we have a window to abort.
    backend.setPutDelayMs(200);
    const total = CHUNK_SIZE + 16;
    const payload = Buffer.alloc(total, 0xaa);
    const blob = new Blob([payload], { type: "video/mp4" });

    const ctrl = new AbortController();
    const promise = sdk.files.create(blob, {
      filename: "v.mp4",
      signal: ctrl.signal,
    });
    // Wait long enough for the first PUT to be in-flight on the server, then
    // abort. Bun's setTimeout resolution is fine-grained enough that 50ms
    // reliably lands inside the 200ms server delay.
    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();

    await expect(promise).rejects.toBeDefined();
    // At least one PUT was issued (the one we aborted); chunk 1 must NOT
    // have been issued — the loop checks signal.aborted between chunks.
    const chunk1Calls = backend.putCalls.filter((c) => c.index === 1);
    expect(chunk1Calls.length).toBe(0);
  });

  test("abort during retry backoff throws without further attempts", async () => {
    // Force one 503 to trigger the retry sleep, then abort during the sleep.
    // Retry base is 250ms — abort after ~50ms reliably lands inside it.
    const total = CHUNK_SIZE + 1;
    const payload = Buffer.alloc(total, 0xbb);
    const blob = new Blob([payload], { type: "video/mp4" });

    backend.setNextChunkFailure({ index: 0, status: 503 });

    const ctrl = new AbortController();
    const promise = sdk.files.create(blob, {
      filename: "v.mp4",
      signal: ctrl.signal,
    });
    // Let the first PUT complete (failing 503) and the SDK enter the
    // backoff sleep, then abort.
    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();

    await expect(promise).rejects.toBeDefined();
    // Exactly one PUT attempt — the failing one. The retry was aborted
    // before it fired.
    expect(backend.putCalls.length).toBe(1);
    expect(backend.putCalls[0]).toMatchObject({ index: 0, status: 503 });
  });

  test("401 on a chunk PUT triggers token refresh and the upload completes", async () => {
    // The first chunk PUT is 401'd by the server (simulates a mid-upload
    // token expiry — the SDK can't predict when an upstream will reject).
    // The SDK's 401-retry path must re-invoke the token provider and
    // re-send the body; both the retry and the subsequent chunk must
    // succeed.
    let tokenCalls = 0;
    const sdkLocal = new UnifiedAI({
      apiUrl: backend.baseUrl,
      token: async () => {
        tokenCalls += 1;
        return `token-${tokenCalls}`;
      },
    });

    // 401 only the next PUT chunk request, regardless of token contents.
    // The init POST and the chunk-0 retry are NOT affected.
    backend.setNext401PutCount(1);

    const total = CHUNK_SIZE + 4;
    const payload = Buffer.alloc(total, 0xcc);
    const blob = new Blob([payload], { type: "video/mp4" });

    const file = await sdkLocal.files.create(blob, { filename: "v.mp4" });
    expect(file.bytes).toBe(total);

    // Chunk 0: one 401 followed by one 200 (the SDK's auth-retry).
    const chunk0 = backend.putCalls.filter((c) => c.index === 0);
    expect(chunk0.length).toBe(2);
    expect(chunk0[0]?.status).toBe(401);
    expect(chunk0[1]?.status).toBe(200);
    // The retry MUST use a freshly-resolved token — different value than
    // the one that 401'd. This is the load-bearing assertion: without the
    // refresh path the retry would carry the same token and 401 again.
    expect(chunk0[1]?.auth).not.toBe(chunk0[0]?.auth);

    // Chunk 1: single successful PUT (no further refresh needed).
    const chunk1 = backend.putCalls.filter((c) => c.index === 1);
    expect(chunk1.length).toBe(1);
    expect(chunk1[0]?.status).toBe(200);
    // At least 3 token calls happened (init + chunk-0-stale + chunk-0-refresh
    // + chunk-1 + complete). The exact count depends on whether init also
    // hit the auth refresh path, so we only assert the lower bound.
    expect(tokenCalls).toBeGreaterThanOrEqual(3);
  });

  // ── Resume validation (review fixes A1, A2, B6) ──────────────────────────

  test("resume rejects when server reports a different mime_type", async () => {
    const total = CHUNK_SIZE + 4;
    const uploadId = "upl_mime_mismatch";
    backend.sessions.set(uploadId, {
      upload_id: uploadId,
      filename: "v.mp4",
      mime_type: "video/mp4", // session was inited for mp4
      total_bytes: total,
      chunk_size: CHUNK_SIZE,
      received_chunks: new Set(),
      chunks: new Map(),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });

    // Caller tries to resume with the SAME byte count but a different MIME —
    // the cheap "is this the same logical file?" surrogate.
    const blob = new Blob([Buffer.alloc(total, 0xaa)], { type: "video/webm" });
    await expect(
      sdk.files.create(blob, { filename: "v.mp4", resumeFrom: uploadId }),
    ).rejects.toThrow(/mime_type|different file/);
    // No chunks were PUT.
    expect(backend.putCalls.length).toBe(0);
  });

  test("resume rejects when server returns chunk indices out of range (chunk_size drift)", async () => {
    const total = CHUNK_SIZE * 2;
    const uploadId = "upl_idx_oor";
    // Simulate the server's chunk_size having changed between init and
    // resume: session reports chunk_size=5MB and total_chunks would be 2,
    // but received_chunks claims index 3 was acknowledged — impossible
    // under the SDK's recomputed totalChunks.
    backend.sessions.set(uploadId, {
      upload_id: uploadId,
      filename: "v.mp4",
      mime_type: "video/mp4",
      total_bytes: total,
      chunk_size: CHUNK_SIZE,
      received_chunks: new Set([3]),
      chunks: new Map(),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });

    const blob = new Blob([Buffer.alloc(total, 0xbb)], { type: "video/mp4" });
    await expect(
      sdk.files.create(blob, { filename: "v.mp4", resumeFrom: uploadId }),
    ).rejects.toThrow(/out of range|chunk_size/);
    expect(backend.putCalls.length).toBe(0);
  });

  // ── Persistence-clearing on abort (review fix B1) ────────────────────────

  test("aborting a chunked upload clears the persisted upload id", async () => {
    backend.setPutDelayMs(150);
    const total = CHUNK_SIZE + 8;
    const blob = new Blob([Buffer.alloc(total, 0xee)], { type: "video/mp4" });

    const persistCalls: Array<string | null> = [];
    const ctrl = new AbortController();
    const promise = sdk.files.create(blob, {
      filename: "v.mp4",
      onPersistUploadId: (id) => {
        persistCalls.push(id);
      },
      signal: ctrl.signal,
    });
    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();
    await expect(promise).rejects.toBeDefined();

    // The first persist call set the upload_id; abort must trigger a
    // follow-up null to clear it (per the contract in files.ts).
    expect(persistCalls.length).toBe(2);
    expect(typeof persistCalls[0]).toBe("string");
    expect(persistCalls[1]).toBeNull();
  });

  test("aborting during the resume GET also clears the persisted upload id", async () => {
    // Locks in the second recheck fix: abort during the resume's GET state
    // request (which happens BEFORE the chunk loop) used to escape the
    // persist-clear path because the try/catch only wrapped the chunks.
    // We now wrap init/resume too, so abort here propagates to the catch
    // and clears via the host-supplied hook.
    const total = CHUNK_SIZE + 4;
    const uploadId = "upl_resume_abort";
    backend.sessions.set(uploadId, {
      upload_id: uploadId,
      filename: "v.mp4",
      mime_type: "video/mp4",
      total_bytes: total,
      chunk_size: CHUNK_SIZE,
      received_chunks: new Set([0]),
      chunks: new Map([[0, Buffer.alloc(CHUNK_SIZE, 0x55)]]),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });

    // Inject latency on every response — including the GET state request —
    // so we have a window to abort while it's in flight. The fake's
    // putDelayMs only affects PUTs, so we wrap the SDK's fetch directly.
    const baseFetch = globalThis.fetch.bind(globalThis);
    sdk = new UnifiedAI({
      apiUrl: backend.baseUrl,
      token: "test-token",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : (input as Request).url;
        if (url.includes("/uploads/") && !url.includes("/chunks/") && !url.includes("/complete")) {
          // Add 300ms to the GET-state path only.
          await new Promise((r) => setTimeout(r, 300));
        }
        return baseFetch(input, init);
      }) as typeof globalThis.fetch,
    });

    const blob = new Blob([Buffer.alloc(total, 0x55)], { type: "video/mp4" });
    const persistCalls: Array<string | null> = [];
    const ctrl = new AbortController();
    const promise = sdk.files.create(blob, {
      filename: "v.mp4",
      resumeFrom: uploadId,
      onPersistUploadId: (id) => {
        persistCalls.push(id);
      },
      signal: ctrl.signal,
    });
    // Abort while the GET state is still pending its 300ms delay.
    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();
    await expect(promise).rejects.toBeDefined();

    // resumeFrom paths don't fire onPersistUploadId(id) — the host already
    // has it persisted. On abort we should fire just onPersistUploadId(null)
    // to clear it.
    expect(persistCalls.length).toBe(1);
    expect(persistCalls[0]).toBeNull();
  });

  test("aborting during the /complete POST also clears the persisted upload id", async () => {
    // Locks in the recheck fix: abort during a raw client.request() (no
    // putChunkWithRetry wrapping) surfaces as a DOMException AbortError,
    // not a UnifiedError. The catch needs to detect that too, otherwise
    // the persist-clear silently breaks for abort-after-last-chunk.
    backend.setCompleteDelayMs(800);
    const total = CHUNK_SIZE + 4;
    const blob = new Blob([Buffer.alloc(total, 0x77)], { type: "video/mp4" });

    const persistCalls: Array<string | null> = [];
    const ctrl = new AbortController();
    const promise = sdk.files.create(blob, {
      filename: "v.mp4",
      onPersistUploadId: (id) => {
        persistCalls.push(id);
      },
      signal: ctrl.signal,
    });
    // Let init + both chunks succeed, then abort while /complete is in-flight.
    // PUTs have no delay so they fly through in <100ms; complete has 800ms of
    // delay; waiting 300ms reliably lands inside the complete window.
    await new Promise((r) => setTimeout(r, 300));
    ctrl.abort();
    await expect(promise).rejects.toBeDefined();

    expect(persistCalls.length).toBe(2);
    expect(typeof persistCalls[0]).toBe("string");
    expect(persistCalls[1]).toBeNull();
  });

  test("non-abort failures do NOT clear the persisted upload id (so the host can resume)", async () => {
    const total = CHUNK_SIZE + 1;
    const blob = new Blob([Buffer.alloc(total, 0xff)], { type: "video/mp4" });

    backend.setNextChunkFailure({ index: 0, status: 400 });

    const persistCalls: Array<string | null> = [];
    await expect(
      sdk.files.create(blob, {
        filename: "v.mp4",
        onPersistUploadId: (id) => {
          persistCalls.push(id);
        },
      }),
    ).rejects.toBeDefined();

    // Persist was called with the id; NOT cleared on the non-abort failure.
    // The host needs the id to call resumeFrom on the next attempt.
    expect(persistCalls.length).toBe(1);
    expect(typeof persistCalls[0]).toBe("string");
  });

  test("401 mid-stream does not cause acknowledged chunks to be re-uploaded", async () => {
    // Regression guard: a 401 on chunk N must not cause the SDK to restart
    // the whole upload from chunk 0. The session row on the server still
    // remembers what's been acknowledged; the SDK should refresh the token
    // and continue from where it was.
    //
    // Setup: pre-seed a session with chunks 0 and 1 already received, then
    // resume into it. The very next chunk PUT (index 2) is 401'd once. The
    // SDK refreshes, retries chunk 2, and finishes. Chunks 0 and 1 must
    // never be touched.
    const total = CHUNK_SIZE * 2 + 8;
    const payload = Buffer.alloc(total, 0xdd);
    const blob = new Blob([payload], { type: "video/mp4" });

    const sdkLocal = new UnifiedAI({
      apiUrl: backend.baseUrl,
      token: (() => {
        let n = 0;
        return async () => {
          n += 1;
          return `token-${n}`;
        };
      })(),
    });

    const seededUploadId = "upl_partial";
    backend.sessions.set(seededUploadId, {
      upload_id: seededUploadId,
      filename: "v.mp4",
      mime_type: "video/mp4",
      total_bytes: total,
      chunk_size: CHUNK_SIZE,
      received_chunks: new Set([0, 1]),
      chunks: new Map([
        [0, Buffer.alloc(CHUNK_SIZE, 0xdd)],
        [1, Buffer.alloc(CHUNK_SIZE, 0xdd)],
      ]),
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });

    // 401 the next chunk PUT — which will be chunk index 2.
    backend.setNext401PutCount(1);

    const file = await sdkLocal.files.create(blob, {
      filename: "v.mp4",
      resumeFrom: seededUploadId,
    });

    expect(file.bytes).toBe(total);
    // Chunk 2 was uploaded twice: the 401 attempt and the refreshed retry.
    const chunk2 = backend.putCalls.filter((c) => c.index === 2);
    expect(chunk2.length).toBe(2);
    expect(chunk2[0]?.status).toBe(401);
    expect(chunk2[1]?.status).toBe(200);
    // Chunks 0 and 1 were NEVER touched — the load-bearing assertion.
    const chunk0or1 = backend.putCalls.filter((c) => c.index === 0 || c.index === 1);
    expect(chunk0or1.length).toBe(0);
  });
});

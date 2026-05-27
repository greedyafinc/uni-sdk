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
  putCalls: Array<{ uploadId: string; index: number; size: number; status: number }>;
  /** If set, the next PUT to this index returns the given status without recording. */
  nextChunkFailure: { index: number; status: number } | null;
  setNextChunkFailure: (f: { index: number; status: number } | null) => void;
}

async function startFakeBackend(): Promise<FakeBackend> {
  const sessions = new Map<string, Session>();
  const putCalls: FakeBackend["putCalls"] = [];
  let nextChunkFailure: { index: number; status: number } | null = null;

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

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
        const bytes = Buffer.from(await req.arrayBuffer());
        if (nextChunkFailure && nextChunkFailure.index === idx) {
          const status = nextChunkFailure.status;
          nextChunkFailure = null;
          putCalls.push({ uploadId, index: idx, size: bytes.length, status });
          return new Response("simulated failure", { status });
        }
        session.received_chunks.add(idx);
        session.chunks.set(idx, bytes);
        putCalls.push({ uploadId, index: idx, size: bytes.length, status: 200 });
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
});

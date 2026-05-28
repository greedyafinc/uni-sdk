import type { Core } from "../../core/core";
import { UnifiedAIError, UnifiedError } from "../../core/errors";
import type { FileObject, UploadProgressListener } from "../files";

/**
 * Server-side chunked-upload contract (mirrors unified-api's
 * /api/v1/files/uploads endpoints). Kept in lockstep with the backend; the
 * `chunk_size` is dictated by the server in the init response so this client
 * does not need to choose a value.
 */
interface InitResponse {
  upload_id: string;
  chunk_size: number;
  expires_at: string;
}

interface ChunkResponse {
  upload_id: string;
  chunk_index: number;
  received_bytes: number;
  total_bytes: number;
}

interface SessionStateResponse {
  upload_id: string;
  filename: string;
  mime_type: string;
  total_bytes: number;
  chunk_size: number;
  received_chunks: number[];
  received_bytes: number;
  expires_at: string;
}

/**
 * Threshold above which `files.create` switches from single-shot multipart
 * to the chunked protocol. Matches the server's default `chunk_size` — for
 * a payload under one chunk, the chunked path is pure overhead.
 */
export const CHUNKED_UPLOAD_THRESHOLD = 5 * 1024 * 1024;

/**
 * Per-chunk retry budget. Each retry waits 2 ** attempt * 250 ms, capped at
 * 5 s — 250 ms, 500 ms, 1 s, 2 s, 4 s, 5 s. Total worst-case retry latency
 * per chunk is ~13 s, then we give up on that chunk and surface the error
 * (the host can resume the session later via `resumeFrom`).
 */
const PER_CHUNK_RETRIES = 6;
const RETRY_BASE_MS = 250;
const RETRY_CAP_MS = 5_000;

/**
 * Persistence hook the host supplies if it wants resume-across-crashes.
 * Called with the active upload_id at session creation, then `null` when the
 * session completes or aborts. The SDK does NOT pick a storage location
 * (localStorage / IndexedDB / fs) — that's an app concern and depends on
 * the runtime.
 */
export type ChunkedUploadPersist = (uploadId: string | null) => void | Promise<void>;

export interface ChunkedUploadOptions {
  blob: Blob;
  filename: string;
  mimeType: string;
  purpose?: string;
  /** Existing session id from a prior interrupted upload. Skip init when set. */
  resumeFrom?: string;
  onProgress?: UploadProgressListener;
  onPersistUploadId?: ChunkedUploadPersist;
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UnifiedError("aborted", "files.create aborted during chunk retry backoff"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new UnifiedError("aborted", "files.create aborted during chunk retry backoff"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function backoffMs(attempt: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
}

/**
 * Emit a progress event without letting a throwing listener tear down the
 * upload. Mirrors the same swallow-on-throw policy used in client.ts —
 * host UI bugs must not abort an otherwise-healthy upload.
 */
function safeEmit(
  listener: UploadProgressListener | undefined,
  loaded: number,
  total: number,
): void {
  if (!listener) return;
  try {
    listener({
      loaded,
      total,
      percent: total > 0 ? Math.floor((loaded / total) * 100) : 0,
    });
  } catch {
    // Host listener errors must not abort the upload.
  }
}

/**
 * Decide whether a chunk PUT failure is worth retrying. Network errors and
 * 5xx are transient; 4xx (except 408 / 429) almost always indicate a client
 * bug (wrong index, expired session, bad MIME) — re-sending bytes won't help.
 */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof UnifiedAIError)) return true; // non-typed → network / parse → retry
  const status = err.status;
  if (status === undefined) return true;
  if (status === 408 || status === 429) return true;
  return status >= 500 && status < 600;
}

async function putChunkWithRetry(
  client: Core,
  uploadId: string,
  index: number,
  bytes: Uint8Array,
  signal: AbortSignal | undefined,
): Promise<ChunkResponse> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= PER_CHUNK_RETRIES; attempt++) {
    if (signal?.aborted) {
      throw new UnifiedError("aborted", "files.create aborted between chunk attempts");
    }
    try {
      return await client.request<ChunkResponse>(
        `/api/v1/files/uploads/${encodeURIComponent(uploadId)}/chunks/${index}`,
        {
          method: "PUT",
          body: bytes,
          contentType: "application/octet-stream",
          ...(signal && { signal }),
        },
      );
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === PER_CHUNK_RETRIES) throw err;
      await sleep(backoffMs(attempt), signal);
    }
  }
  // Defensive: the loop above either returns on success or throws on the
  // final attempt. Reaching this line would indicate a logic bug in the
  // retry budget; surface `lastErr` explicitly so it isn't swallowed.
  throw lastErr ?? new Error("putChunkWithRetry exited without return or throw");
}

/**
 * Drive a chunked upload to completion. Handles init/resume, per-chunk retry,
 * progress aggregation, and host-side session-id persistence. Returns the
 * resulting `FileObject` exactly as `files.create` does for the single-shot
 * path.
 */
export async function performChunkedUpload(
  client: Core,
  opts: ChunkedUploadOptions,
): Promise<FileObject> {
  if (opts.signal?.aborted) {
    throw new UnifiedError("aborted", "files.create aborted before chunked upload began");
  }
  const totalBytes = opts.blob.size;

  let uploadId: string;
  let chunkSize: number;
  let receivedChunks = new Set<number>();
  // True once the persisted upload id is "live" (either init's persist hook
  // succeeded OR the caller passed resumeFrom — implying a previous call's
  // persist is still in host storage). The catch path uses this to decide
  // whether an `onPersistUploadId(null)` call is meaningful: if no id is
  // live, clearing would either be a no-op or wrongly trample a different
  // upload's persisted id that the host happens to share the slot with.
  let needsClearOnAbort = false;

  // Wrap init/resume AND the upload loop in one try so an abort anywhere
  // (including the GET state / init POST themselves) goes through the
  // persist-clear path.
  try {
    if (opts.resumeFrom) {
      // Caller passed resumeFrom: by construction the host has the id in
      // storage from a prior call. Mark clearable BEFORE the network call,
      // so an abort during the GET state below still triggers the clear.
      needsClearOnAbort = true;
      // Resume path: ask the server what it already has so we don't re-send
      // acknowledged chunks. Three things have to match between the original
      // init and the resume:
      //
      //   - total_bytes: a different size means a different payload, period.
      //   - mime_type: same length but different content (e.g. video_a.mp4 vs
      //     video_b.mp4 both 10 MB) would otherwise stitch a Frankenstein
      //     file under video_a's stored metadata. Cheap surrogate for "is
      //     this the same logical file" — short of a content hash, which
      //     would force an extra full-payload read on every resume.
      //   - chunk_size: if the server's chunk_size changed between init and
      //     resume, the already-acknowledged indices in `received_chunks`
      //     refer to byte ranges under the OLD size, and slicing/skipping
      //     under the NEW size produces a corrupt upload. We detect this
      //     by validating every received index is in `[0, totalChunks)`
      //     for the size we're about to use — a chunk_size change makes
      //     stale indices fall out of range.
      const state = await client.request<SessionStateResponse>(
        `/api/v1/files/uploads/${encodeURIComponent(opts.resumeFrom)}`,
        { method: "GET", ...(opts.signal && { signal: opts.signal }) },
      );
      if (state.total_bytes !== totalBytes) {
        throw new UnifiedError(
          "invalid_input",
          `resume session expected ${state.total_bytes} bytes; current payload is ${totalBytes}`,
        );
      }
      if (state.mime_type !== opts.mimeType) {
        throw new UnifiedError(
          "invalid_input",
          `resume session has mime_type ${state.mime_type}; current payload is ${opts.mimeType} (different file?)`,
        );
      }
      // Filename is also a cheap "same logical file" signal: a host with
      // multiple in-flight uploads of the same size and mime (e.g. two
      // different PDFs from the same scanner) would otherwise have its
      // resume silently stitched under the wrong stored name. The server
      // keeps the filename from init, so we have to defer to it for
      // consistency rather than overwrite.
      if (state.filename !== opts.filename) {
        throw new UnifiedError(
          "invalid_input",
          `resume session has filename ${state.filename}; current payload is ${opts.filename} (different file?)`,
        );
      }
      uploadId = state.upload_id;
      chunkSize = state.chunk_size;
      const expectedTotalChunks = totalBytes === 0 ? 0 : Math.ceil(totalBytes / chunkSize);
      // Zero-byte uploads have no chunks to validate; the upload loop below
      // skips for the same reason. Skipping here avoids a misleading
      // "chunk_size drift" error for the (unusual but legal) empty-file case.
      if (totalBytes > 0) {
        for (const idx of state.received_chunks) {
          if (!Number.isInteger(idx) || idx < 0 || idx >= expectedTotalChunks) {
            throw new UnifiedError(
              "invalid_input",
              `resume session has chunk index ${idx} out of range [0, ${expectedTotalChunks}) — server may have changed chunk_size between init and resume`,
            );
          }
        }
      }
      receivedChunks = new Set(state.received_chunks);
    } else {
      const init = await client.request<InitResponse>("/api/v1/files/uploads", {
        method: "POST",
        body: {
          filename: opts.filename,
          mime_type: opts.mimeType,
          total_bytes: totalBytes,
          ...(opts.purpose ? { purpose: opts.purpose } : {}),
        },
        ...(opts.signal && { signal: opts.signal }),
      });
      uploadId = init.upload_id;
      chunkSize = init.chunk_size;
      // Tell the host so it can persist across crashes. Errors in the hook are
      // intentional non-fatal — losing resume-on-crash is acceptable; failing
      // an otherwise-good upload because the host's storage flaked is not.
      if (opts.onPersistUploadId) {
        try {
          await opts.onPersistUploadId(uploadId);
          needsClearOnAbort = true;
        } catch {
          // Persist hook failure is non-fatal. We still need to attempt the
          // upload — the host loses resume-on-crash for this session but
          // keeps a working upload. Leave needsClearOnAbort false: if the
          // host's storage is broken, we don't try to clear via the same
          // broken hook on abort either.
        }
      }
    }

    const totalChunks = totalBytes === 0 ? 0 : Math.ceil(totalBytes / chunkSize);

    // Emit a synthetic 0/total before any bytes flow. On resume we still start
    // from 0 — the host sees acknowledged-chunks progress jump to whatever's
    // already done on the first emit after the first PUT.
    safeEmit(opts.onProgress, 0, totalBytes);

    // Account for bytes already on the server (resume case). Counted toward
    // progress immediately so the listener doesn't first report 0 % then jump
    // when the next acknowledged chunk lands.
    let loaded = 0;
    for (const idx of receivedChunks) {
      const isLast = idx === totalChunks - 1;
      loaded += isLast ? totalBytes - chunkSize * idx : chunkSize;
    }
    if (loaded > 0) safeEmit(opts.onProgress, loaded, totalBytes);

    // The outer try (opened at line ~165) wraps init/resume + the upload loop
    // + complete in one scope so an abort anywhere takes the persist-clear
    // path. Non-abort failures intentionally leave the persisted id alone —
    // the whole point of persistence is so the host can call again with
    // resumeFrom and pick up where we left off.
    for (let i = 0; i < totalChunks; i++) {
      if (receivedChunks.has(i)) continue;
      if (opts.signal?.aborted) {
        throw new UnifiedError("aborted", "files.create aborted between chunks");
      }
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, totalBytes);
      // .slice() on a Blob is cheap — view, not copy. arrayBuffer() materializes
      // just this slice's bytes.
      const chunkBytes = new Uint8Array(await opts.blob.slice(start, end).arrayBuffer());
      await putChunkWithRetry(client, uploadId, i, chunkBytes, opts.signal);
      loaded += chunkBytes.byteLength;
      safeEmit(opts.onProgress, loaded, totalBytes);
    }

    const file = await client.request<FileObject>(
      `/api/v1/files/uploads/${encodeURIComponent(uploadId)}/complete`,
      { method: "POST", ...(opts.signal && { signal: opts.signal }) },
    );

    // Successful completion: clear the persisted session id so a future load
    // of the same host doesn't try to resume a finished upload.
    if (opts.onPersistUploadId) {
      try {
        await opts.onPersistUploadId(null);
      } catch {
        // swallow
      }
    }

    return file;
  } catch (err) {
    // Aborted uploads explicitly clear — the user said cancel; resuming
    // would defeat that. The abort can surface three ways:
    //   - UnifiedError code "aborted" from our own abort checks
    //   - raw DOMException("AbortError") from a fetch we never wrapped
    //     (init POST, GET state, /complete POST — the request layer
    //     surfaces the AbortError unchanged)
    //   - any other error class while the signal is in aborted state
    // We treat all three as abort to honor the contract robustly.
    const isAborted =
      (err instanceof UnifiedError && err.code === "aborted") ||
      (err instanceof Error && err.name === "AbortError") ||
      opts.signal?.aborted === true;
    if (isAborted && needsClearOnAbort && opts.onPersistUploadId) {
      try {
        await opts.onPersistUploadId(null);
      } catch {
        // swallow
      }
    }
    throw err;
  }
}

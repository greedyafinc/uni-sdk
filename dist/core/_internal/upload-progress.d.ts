import type { UploadProgressListener } from "../core.js";
/**
 * Build the upload-progress plan for one multipart request, or `undefined`
 * when the caller didn't supply a progress listener (the request then sends
 * the FormData untouched with zero overhead).
 *
 * For progress-tracked multipart uploads we need to know the total byte
 * count and to be able to wrap each send in a fresh counting stream (for
 * the 401-retry path). Encoding the FormData to a Blob up front gives us
 * both — the encoded multipart payload (including boundaries) and the
 * exact Content-Type with that boundary. See PROGRESS_BLOB_MAX_BYTES above
 * for why encoding is skipped past the cap.
 */
export declare function prepareUploadProgress(form: FormData, onProgress: UploadProgressListener | undefined): Promise<UploadProgress | undefined>;
/**
 * Per-request progress bookkeeping for a multipart upload. One instance is
 * created per `request()` call (via {@link prepareUploadProgress}) and drives
 * the three touch-points the request path needs:
 *
 * - {@link beginAttempt} — the 0/total bookend, once per send attempt.
 * - {@link body} — the wrapped counting stream (or `undefined` above the cap).
 * - {@link finish} — the final synthetic bookend for the unwrapped path.
 */
export declare class UploadProgress {
    private readonly onProgress;
    private readonly blob;
    private readonly estimatedBytes;
    constructor(onProgress: UploadProgressListener, blob: Blob | undefined, estimatedBytes: number);
    /**
     * Emit the 0/total bookend. Called once per send so a 401 → refresh → retry
     * shows hosts a clean "we're restarting from byte 0" marker, instead of
     * silently resetting `loaded` partway through the listener's stream.
     * Without this, listeners that assume monotonic `loaded` would see
     * it climb on attempt 1, drop on attempt 2, climb again — the test
     * `tests/node/files.test.ts` documents the per-attempt-monotonic
     * shape, and consumers may rely on the 0-bookend to know when a
     * restart happened.
     *
     * Above the wrap cap we use the pre-encode estimate so listeners
     * still get a meaningful `total` (otherwise a 200 MB upload would
     * report total=0 on its bookend, which divides-by-zero in any
     * percent-driven UI).
     */
    beginAttempt(): void;
    /**
     * The progress-counting request body for this attempt, or `undefined` when
     * the payload was above the wrap cap (the caller then sends the original
     * FormData as-is). Returns a FRESH stream per call so a 401-retry can
     * re-send the same encoded bytes. `contentType` carries the multipart
     * boundary — we're sending the pre-encoded bytes ourselves, so the caller
     * must set it explicitly (fetch only does that automatically when body is
     * a real FormData instance).
     */
    body(): {
        stream: ReadableStream<Uint8Array>;
        contentType: string;
    } | undefined;
    /**
     * Final bookend for the above-cap progress path. The wrapping branch
     * already emits total/total naturally as the last chunk drains, so
     * this is a no-op unless the FormData was sent as-is. The `total` here
     * is the pre-encode estimate — a few hundred bytes off from the wire
     * truth, but stable enough for "upload finished" UI. Callers invoke it
     * only after an ok response.
     */
    finish(): void;
}
//# sourceMappingURL=upload-progress.d.ts.map
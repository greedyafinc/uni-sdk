import type { UploadProgressListener } from "../core";
import { safeEmit } from "./progress";

/**
 * Wrapping a multipart body for byte-level progress requires encoding the
 * whole FormData to a single in-memory Blob (so we know its exact size and
 * Content-Type with boundary). For a multi-hundred-MB upload that's an
 * O(payload) memory spike. We avoid it by ESTIMATING the encoded size first —
 * walking FormData parts and summing their .size / encoded string length —
 * and only wrap below PROGRESS_BLOB_MAX_BYTES. Above the cap we ship the
 * original FormData (lazily streamable by fetch) and emit only coarse
 * synthetic bookends, since the alternative is a likely-OOM.
 *
 * For files.create() this only matters as a backstop — its chunked path kicks
 * in at 5 MB and emits per-chunk progress separately. The cap here protects
 * files.upload() and any future single-shot caller that opts into progress
 * for a huge payload.
 */
const PROGRESS_BLOB_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Estimate the byte size of a FormData after multipart encoding, WITHOUT
 * materializing it. Walks parts and sums `value.size` (Blob/File) or the
 * UTF-8 encoded length (string parts), plus a generous per-part overhead
 * for boundaries and headers. Pessimistic by design — we use this only
 * to decide whether the actual encoding is safe to do, so over-estimating
 * is fine (we skip wrapping and the host gets coarser progress) but
 * under-estimating would defeat the cap.
 */
function estimateFormDataBytes(form: FormData): number {
  let total = 0;
  let partCount = 0;
  const encoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : undefined;
  for (const [name, value] of form.entries()) {
    partCount += 1;
    // RFC 7578 encodes the field name into the Content-Disposition header;
    // we approximate its contribution by its UTF-8 byte length. The
    // per-part overhead added below covers the surrounding header bytes
    // (`Content-Disposition: form-data; name="..."` + CRLFs) — the goal is
    // an over-estimate, not an exact match.
    total += encoder ? encoder.encode(name).length : name.length;
    if (typeof value === "string") {
      total += encoder ? encoder.encode(value).length : value.length;
    } else {
      // FormDataEntryValue = string | File; the else branch is a File but
      // tsc's `for...of` narrowing loses that without an explicit cast.
      total += (value as Blob).size;
    }
  }
  // ~200 bytes per part covers boundary + Content-Disposition + Content-Type
  // headers with room to spare. The trailing boundary adds another ~50.
  total += partCount * 200 + 50;
  return total;
}

/**
 * Wrap a Blob's stream so each pulled chunk fires a progress event before it
 * reaches the network. Returns a fresh stream every call so the body can be
 * re-sent on a 401 retry — `Blob.stream()` is one-shot per ReadableStream,
 * but the underlying Blob can be re-streamed indefinitely.
 *
 * The listener is invoked from a microtask after `controller.enqueue`; if it
 * throws, the error is swallowed — a buggy host callback must not corrupt the
 * upload mid-flight.
 */
function progressStream(
  blob: Blob,
  onProgress: UploadProgressListener,
): ReadableStream<Uint8Array> {
  const total = blob.size;
  const reader = blob.stream().getReader();
  let loaded = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      loaded += value.byteLength;
      controller.enqueue(value);
      safeEmit(onProgress, loaded, total);
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

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
export async function prepareUploadProgress(
  form: FormData,
  onProgress: UploadProgressListener | undefined,
): Promise<UploadProgress | undefined> {
  if (typeof onProgress !== "function") return undefined;
  const estimatedBytes = estimateFormDataBytes(form);
  const blob =
    estimatedBytes <= PROGRESS_BLOB_MAX_BYTES ? await new Response(form).blob() : undefined;
  return new UploadProgress(onProgress, blob, estimatedBytes);
}

/**
 * Per-request progress bookkeeping for a multipart upload. One instance is
 * created per `request()` call (via {@link prepareUploadProgress}) and drives
 * the three touch-points the request path needs:
 *
 * - {@link beginAttempt} — the 0/total bookend, once per send attempt.
 * - {@link body} — the wrapped counting stream (or `undefined` above the cap).
 * - {@link finish} — the final synthetic bookend for the unwrapped path.
 */
export class UploadProgress {
  constructor(
    private readonly onProgress: UploadProgressListener,
    private readonly blob: Blob | undefined,
    private readonly estimatedBytes: number,
  ) {}

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
  beginAttempt(): void {
    safeEmit(this.onProgress, 0, this.blob?.size ?? this.estimatedBytes);
  }

  /**
   * The progress-counting request body for this attempt, or `undefined` when
   * the payload was above the wrap cap (the caller then sends the original
   * FormData as-is). Returns a FRESH stream per call so a 401-retry can
   * re-send the same encoded bytes. `contentType` carries the multipart
   * boundary — we're sending the pre-encoded bytes ourselves, so the caller
   * must set it explicitly (fetch only does that automatically when body is
   * a real FormData instance).
   */
  body(): { stream: ReadableStream<Uint8Array>; contentType: string } | undefined {
    if (!this.blob) return undefined;
    return { stream: progressStream(this.blob, this.onProgress), contentType: this.blob.type };
  }

  /**
   * Final bookend for the above-cap progress path. The wrapping branch
   * already emits total/total naturally as the last chunk drains, so
   * this is a no-op unless the FormData was sent as-is. The `total` here
   * is the pre-encode estimate — a few hundred bytes off from the wire
   * truth, but stable enough for "upload finished" UI. Callers invoke it
   * only after an ok response.
   */
  finish(): void {
    if (this.blob) return;
    safeEmit(this.onProgress, this.estimatedBytes, this.estimatedBytes);
  }
}

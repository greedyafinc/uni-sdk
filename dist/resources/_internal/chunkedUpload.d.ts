import type { Core } from "../../core/core.js";
import type { FileObject, UploadProgressListener } from "../files.js";
/**
 * Threshold above which `files.create` switches from single-shot multipart
 * to the chunked protocol. Matches the server's default `chunk_size` — for
 * a payload under one chunk, the chunked path is pure overhead.
 */
export declare const CHUNKED_UPLOAD_THRESHOLD: number;
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
/**
 * Drive a chunked upload to completion. Handles init/resume, per-chunk retry,
 * progress aggregation, and host-side session-id persistence. Returns the
 * resulting `FileObject` exactly as `files.create` does for the single-shot
 * path.
 */
export declare function performChunkedUpload(client: Core, opts: ChunkedUploadOptions): Promise<FileObject>;
//# sourceMappingURL=chunkedUpload.d.ts.map
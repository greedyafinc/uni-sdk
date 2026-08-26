import type { Core, UploadProgressListener } from "../core/core.js";
import { type ChunkedUploadPersist } from "./_internal/chunkedUpload.js";
export type { UploadProgressEvent, UploadProgressListener } from "../core/core.js";
export type { ChunkedUploadPersist } from "./_internal/chunkedUpload.js";
/**
 * Source for `files.upload`. Anything that resolves to raw bytes:
 *   - Blob / File              (browser, Node 18+)
 *   - Buffer / Uint8Array      (Node)
 *   - ArrayBuffer
 *   - base64 data URL string
 *
 * Hosted URLs (`https://...`) and provider file ids (`{ fileId }`) are
 * intentionally rejected with a targeted error — there is nothing to upload,
 * and accepting them silently would mask programming errors.
 */
export type FileUploadSource = Blob | ArrayBuffer | Uint8Array | string;
export interface FileRequestOptions {
    signal?: AbortSignal;
}
export interface FileUploadOptions extends FileRequestOptions {
    /** Override the multipart filename. Defaults to the source's name (if any), else a mime-based default. */
    filename?: string;
    /** Override the multipart content type. Defaults to the source's type, magic-byte sniff, or `application/octet-stream`. */
    contentType?: string;
    /**
     * Byte-level upload progress. Fires once with `loaded: 0` before any bytes
     * are sent, then again each time a chunk reaches the network, ending with
     * `loaded === total`. On a 401-refresh retry the sequence is restarted from
     * 0 because the body has to be re-sent.
     */
    onProgress?: UploadProgressListener;
}
export interface FileUploadResponse {
    /**
     * Stable id for the uploaded file. Pass it as `file_id` to any multimodal
     * content part (`input_image`, `input_audio`, `input_video`, `input_file`,
     * or chat `file`) across `responses.create`, `chat.completions.create`,
     * and `messages.create` — the gateway resolves it server-side to the
     * right transport for the routed provider. Also acceptable wherever an
     * `image_url`-shaped reference is taken (e.g. `images.edit`).
     */
    file_id: string;
    /** Time-limited signed URL (the backend currently expires it after ~1h). */
    image_url: string;
    /** Optional expiry timestamp, if the backend includes it. */
    expires_at?: string;
}
/**
 * A file managed by the gateway. Returned by `files.create`, `files.list`,
 * and `files.retrieve`. The `id` is usable as a `file_id` in any multimodal
 * content part across `chat.completions.create`, `responses.create`, and
 * `messages.create` — the gateway resolves it to the right transport for
 * the routed provider at request time.
 */
export interface FileObject {
    id: string;
    filename: string;
    mime_type: string;
    bytes: number;
    /** Free-form tag from `create({ purpose })`. Default is `"assistants"`. */
    purpose: string;
    /** ISO 8601 timestamp. */
    created_at: string;
}
export interface FileListResponse {
    data: FileObject[];
}
export interface FileDeleteResponse {
    id: string;
    deleted: boolean;
}
export interface FileCreateOptions extends FileUploadOptions {
    /** Free-form tag stored on the file. Defaults to `"assistants"`. */
    purpose?: string;
    /**
     * Size in bytes above which `create()` switches from single-shot multipart
     * to the resumable chunked-upload protocol. Defaults to 5 MB — matches the
     * server-side chunk size, so anything smaller is one chunk anyway and the
     * chunked-path overhead is wasted.
     *
     * Set to `Infinity` to disable chunked uploads entirely (legacy behavior).
     */
    chunkedUploadThreshold?: number;
    /**
     * Resume an interrupted chunked upload. Pass the `upload_id` that was
     * persisted (via `onPersistUploadId`) from a prior call that failed
     * mid-flight. The SDK queries the server for which chunks made it through
     * and only re-sends the missing ones.
     *
     * The resumed call must pass the same payload identity as the original
     * init — same `filename` (or none, so the same default applies), same
     * mime type, and same total byte count. The SDK enforces this by
     * comparing against the server's recorded session and throwing
     * `invalid_input` on mismatch, to prevent silently stitching a different
     * file onto the original session's metadata.
     */
    resumeFrom?: string;
    /**
     * Persistence hook for the active chunked-upload session id. Called with
     * the id immediately after session init, and with `null` once the upload
     * completes (or aborts). The SDK does NOT pick a storage location — the
     * host writes it to `localStorage`, `IndexedDB`, or whatever else matches
     * the runtime. Hook errors are swallowed; losing resume-on-crash must not
     * break an otherwise-good upload.
     */
    onPersistUploadId?: ChunkedUploadPersist;
}
export interface FileContent {
    bytes: ArrayBuffer;
    contentType: string;
    filename?: string;
}
/**
 * Files resource. Wraps the unified-api file endpoints.
 *
 * Two upload surfaces are available:
 *   - `upload()` — image-only convenience that also returns a signed
 *     `image_url`, intended for `images.edit` callers who want both a stable
 *     handle and a URL they can pass directly back as `image_url`.
 *   - `create()` — general-purpose upload that accepts any allowed MIME
 *     (image, audio, video, PDF) and returns a `FileObject` with metadata.
 *     Use this for non-image inputs to `chat.completions.create`,
 *     `responses.create`, and `messages.create`.
 *
 * Files created via either path are managed through the same surface:
 * `list()`, `retrieve(id)`, `del(id)`, and `content(id)` for raw bytes.
 *
 * The returned `file_id` is usable as a multimodal `file_id` reference in
 * any content part (`input_image`, `input_audio`, `input_video`,
 * `input_file`, or chat `file`); the gateway resolves it server-side.
 */
export declare class Files {
    private readonly client;
    constructor(client: Core);
    /**
     * Upload a user-supplied reference image and return both a stable
     * `file_id` and a short-lived signed `image_url` that can be passed
     * back to `images.edit` as `image_url`. Image-only — for audio / video /
     * PDF uploads, use `create()` instead.
     */
    upload(source: FileUploadSource, options?: FileUploadOptions): Promise<FileUploadResponse>;
    /**
     * Upload a file of any allowed MIME type (image, audio, video, PDF) to
     * the gateway. Returns a `FileObject` whose `id` can be passed as
     * `file_id` to any multimodal content part. Unlike `upload()`, this does
     * NOT return a signed URL — use `content(id)` to fetch raw bytes back, or
     * call `upload()` instead if you need an `image_url` for `images.edit`.
     */
    create(source: FileUploadSource, options?: FileCreateOptions): Promise<FileObject>;
    /** List files owned by the authenticated user, newest first. */
    list(options?: FileRequestOptions): Promise<FileListResponse>;
    /** Fetch metadata for a single file. Throws if the file does not exist or is owned by another user. */
    retrieve(id: string, options?: FileRequestOptions): Promise<FileObject>;
    /**
     * Delete a file. Removes both the metadata row and the underlying blob.
     * Idempotent against follow-up retrieves (subsequent calls 404).
     *
     * Method named `del` because `delete` is a JavaScript reserved word in
     * some legacy contexts; `del` matches the convention used by other
     * OpenAI-compatible SDKs.
     */
    del(id: string, options?: FileRequestOptions): Promise<FileDeleteResponse>;
    /**
     * Download the raw bytes of a previously uploaded file. The returned
     * `contentType` is the value stored at upload time (the same MIME echoed
     * by `retrieve(id).mime_type`); `filename` mirrors `retrieve(id).filename`.
     */
    content(id: string, options?: FileRequestOptions): Promise<FileContent>;
}
//# sourceMappingURL=files.d.ts.map
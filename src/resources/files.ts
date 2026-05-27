import type { Core, RequestOptions, UploadProgressListener } from "../core/core";
import { UnifiedError } from "../core/errors";
import {
  CHUNKED_UPLOAD_THRESHOLD,
  type ChunkedUploadPersist,
  performChunkedUpload,
} from "./_internal/chunkedUpload";
import { parseContentDispositionFilename } from "./_internal/contentDisposition";

export type { UploadProgressEvent, UploadProgressListener } from "../core/core";
export type { ChunkedUploadPersist } from "./_internal/chunkedUpload";

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

function inputError(message: string): UnifiedError {
  return new UnifiedError("invalid_input", message);
}

const DEFAULT_CT = "application/octet-stream";

const EXT_FOR_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

function defaultFilenameFor(mime: string | undefined): string {
  const ext = mime ? EXT_FOR_MIME[mime] : undefined;
  return ext ? `upload${ext}` : "upload";
}

// Minimal magic-byte sniffer for the mime types the upload endpoint accepts.
// Mirrors the broader detector in helpers.ts but kept local to avoid coupling
// the resource to that module's internals.
function sniffMime(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }
  // RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return undefined;
}

function decodeBase64(b64: string): Uint8Array {
  // Strip whitespace — pretty-printed / line-wrapped base64 is common (PEM,
  // `openssl base64`, copy-paste from textareas). Node's Buffer tolerates it
  // but browser `atob` throws InvalidCharacterError on `\n`/spaces.
  const cleaned = b64.replace(/\s+/g, "");
  const g = globalThis as {
    Buffer?: {
      from(s: string, enc: string): { buffer: ArrayBuffer; byteOffset: number; byteLength: number };
    };
  };
  if (g.Buffer) {
    const buf = g.Buffer.from(cleaned, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  if (typeof atob === "function") {
    const bin = atob(cleaned);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  throw inputError("no base64 decoder available (neither Buffer nor atob)");
}

interface NormalisedUpload {
  blob: Blob;
  filename: string;
}

function rejectDiscriminatedObject(source: object): never {
  // Hand back the same targeted errors as helpers.ts so callers who mistakenly
  // pass a multimodal-helper-shaped source get a useful hint instead of the
  // generic "unsupported" catch-all.
  const s = source as { fileId?: unknown; url?: unknown; data?: unknown };
  const hits: string[] = [];
  if (typeof s.fileId === "string") hits.push("fileId");
  if (typeof s.url === "string") hits.push("url");
  if (typeof s.data === "string") hits.push("data");
  if (hits.length > 1) {
    throw inputError(
      `files.upload source has overlapping transports (${hits.join(", ")}); pass a single Blob/Buffer/Uint8Array/ArrayBuffer or base64 data URL`,
    );
  }
  if (typeof s.fileId === "string") {
    throw inputError(
      "files.upload does not accept `{ fileId }` — a fileId is the OUTPUT of upload. Pass it directly to images.edit / responses.create / chat.completions.create instead.",
    );
  }
  if (typeof s.url === "string") {
    throw inputError(
      "files.upload does not accept `{ url }` — hosted URLs cannot be re-uploaded. Fetch the bytes yourself (`await (await fetch(url)).blob()`) and pass the Blob.",
    );
  }
  if (typeof s.data === "string") {
    throw inputError(
      "files.upload does not accept `{ data, mimeType }` — pass a base64 data URL string (`data:<mime>;base64,<payload>`) or decode the bytes yourself.",
    );
  }
  throw inputError(
    "unsupported file source; expected Blob/File/Buffer/Uint8Array/ArrayBuffer or a base64 data URL",
  );
}

async function normalise(
  source: FileUploadSource,
  opts: FileUploadOptions,
): Promise<NormalisedUpload> {
  if (typeof source === "string") {
    if (!source.startsWith("data:")) {
      throw inputError(
        "string source must be a base64 data URL. Hosted URLs and raw base64 cannot be uploaded directly; " +
          "fetch the bytes yourself and pass a Blob/Uint8Array.",
      );
    }
    const comma = source.indexOf(",");
    if (comma < 0) throw inputError("malformed data URL (missing comma)");
    const meta = source.slice(5, comma);
    const payload = source.slice(comma + 1);
    if (!/;base64(?:;|$)/i.test(meta)) {
      throw inputError("data URL must be base64-encoded (data:<mime>;base64,<payload>)");
    }
    const mimeFromUrl = meta.split(";")[0] || undefined;
    const bytes = decodeBase64(payload);
    // Prefer explicit override → declared mime → magic-byte sniff → default.
    const mime = opts.contentType || mimeFromUrl || sniffMime(bytes) || DEFAULT_CT;
    return {
      blob: new Blob([bytes as BlobPart], { type: mime }),
      filename: opts.filename || defaultFilenameFor(mime),
    };
  }

  // Reject fetch Response/Request explicitly — both expose `arrayBuffer()` and
  // would otherwise slip through the duck-type check below, silently draining
  // the body in a way the caller didn't intend.
  if (typeof Response !== "undefined" && source instanceof Response) {
    throw inputError(
      "fetch Response is not a supported file source. Convert it first via `await res.blob()`.",
    );
  }
  if (typeof Request !== "undefined" && source instanceof Request) {
    throw inputError(
      "fetch Request is not a supported file source. Pass the underlying body bytes or a Blob.",
    );
  }

  if (source instanceof Uint8Array) {
    const mime = opts.contentType || sniffMime(source) || DEFAULT_CT;
    return {
      blob: new Blob([source as BlobPart], { type: mime }),
      filename: opts.filename || defaultFilenameFor(mime),
    };
  }

  if (source instanceof ArrayBuffer) {
    const view = new Uint8Array(source);
    const mime = opts.contentType || sniffMime(view) || DEFAULT_CT;
    return {
      blob: new Blob([source], { type: mime }),
      filename: opts.filename || defaultFilenameFor(mime),
    };
  }

  if (typeof Blob !== "undefined" && source instanceof Blob) {
    const sourceType = source.type || "";
    // `||` (not `??`): an empty string from `source.type` must fall through to
    // the sniff/default, otherwise we'd send Content-Type: "" which the
    // image-only backend rejects with 400.
    let mime = opts.contentType || sourceType || "";
    if (!mime) {
      // Sniff bytes when the Blob lacks a declared type (clipboard / drag-drop
      // sources often have type === "").
      const bytes = new Uint8Array(await source.arrayBuffer());
      mime = sniffMime(bytes) || DEFAULT_CT;
      const sourceName = (source as Blob & { name?: unknown }).name;
      const filename =
        opts.filename ||
        (typeof sourceName === "string" && sourceName ? sourceName : defaultFilenameFor(mime));
      return { blob: new Blob([bytes as BlobPart], { type: mime }), filename };
    }
    const sourceName = (source as Blob & { name?: unknown }).name;
    const filename =
      opts.filename ||
      (typeof sourceName === "string" && sourceName ? sourceName : defaultFilenameFor(mime));
    const blob = mime === sourceType ? source : new Blob([source], { type: mime });
    return { blob, filename };
  }

  // Cross-realm Blob — duck-type the Blob shape (arrayBuffer + slice + numeric
  // size). The `slice` requirement is what distinguishes a real Blob from a
  // discriminated-object source that happens to expose `arrayBuffer` and
  // `size` (e.g. `{ fileId, arrayBuffer, size: 0 }`).
  if (
    typeof source === "object" &&
    source !== null &&
    typeof (source as { arrayBuffer?: unknown }).arrayBuffer === "function" &&
    typeof (source as { slice?: unknown }).slice === "function" &&
    typeof (source as { size?: unknown }).size === "number"
  ) {
    const s = source as {
      arrayBuffer: () => Promise<ArrayBuffer>;
      type?: unknown;
      name?: unknown;
    };
    const buf = await s.arrayBuffer();
    const view = new Uint8Array(buf);
    const sourceType = typeof s.type === "string" ? s.type : "";
    const mime = opts.contentType || sourceType || sniffMime(view) || DEFAULT_CT;
    const sourceName = typeof s.name === "string" ? s.name : "";
    return {
      blob: new Blob([buf], { type: mime }),
      filename: opts.filename || sourceName || defaultFilenameFor(mime),
    };
  }

  if (typeof source === "object" && source !== null) {
    rejectDiscriminatedObject(source);
  }

  throw inputError(
    "unsupported file source; expected Blob/File/Buffer/Uint8Array/ArrayBuffer or a base64 data URL",
  );
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
export class Files {
  constructor(private readonly client: Core) {}

  /**
   * Upload a user-supplied reference image and return both a stable
   * `file_id` and a short-lived signed `image_url` that can be passed
   * back to `images.edit` as `image_url`. Image-only — for audio / video /
   * PDF uploads, use `create()` instead.
   */
  async upload(
    source: FileUploadSource,
    options: FileUploadOptions = {},
  ): Promise<FileUploadResponse> {
    // Honor a pre-aborted signal before doing any work (especially before
    // potentially-large arrayBuffer() copies in normalise()).
    if (options.signal?.aborted) {
      throw new UnifiedError("aborted", "files.upload aborted before request was sent");
    }
    const { blob, filename } = await normalise(source, options);
    if (options.signal?.aborted) {
      throw new UnifiedError("aborted", "files.upload aborted before request was sent");
    }
    const form = new FormData();
    // `||` (not `??`) so an empty-string filename still falls back — some
    // browser File sources (clipboard, synthesised Blobs) produce `name === ""`.
    form.append("file", blob, filename || defaultFilenameFor(blob.type));
    const req: RequestOptions = { method: "POST", body: form };
    if (options.signal) req.signal = options.signal;
    if (options.onProgress) req.onUploadProgress = options.onProgress;
    return this.client.request<FileUploadResponse>("/api/v1/images/uploads", req);
  }

  /**
   * Upload a file of any allowed MIME type (image, audio, video, PDF) to
   * the gateway. Returns a `FileObject` whose `id` can be passed as
   * `file_id` to any multimodal content part. Unlike `upload()`, this does
   * NOT return a signed URL — use `content(id)` to fetch raw bytes back, or
   * call `upload()` instead if you need an `image_url` for `images.edit`.
   */
  async create(source: FileUploadSource, options: FileCreateOptions = {}): Promise<FileObject> {
    if (options.signal?.aborted) {
      throw new UnifiedError("aborted", "files.create aborted before request was sent");
    }
    const { blob, filename } = await normalise(source, options);
    if (options.signal?.aborted) {
      throw new UnifiedError("aborted", "files.create aborted before request was sent");
    }

    // Resumable path. Triggered above the threshold OR when the caller is
    // explicitly resuming a prior session. Mime type is required by the
    // chunked endpoint, so we use the normalized blob type (which has
    // already been resolved through opts.contentType → source.type →
    // magic-byte sniff → application/octet-stream).
    const threshold = options.chunkedUploadThreshold ?? CHUNKED_UPLOAD_THRESHOLD;
    if (options.resumeFrom || blob.size > threshold) {
      return performChunkedUpload(this.client, {
        blob,
        filename: filename || defaultFilenameFor(blob.type),
        mimeType: blob.type || "application/octet-stream",
        ...(options.purpose !== undefined && { purpose: options.purpose }),
        ...(options.resumeFrom !== undefined && { resumeFrom: options.resumeFrom }),
        ...(options.onProgress !== undefined && { onProgress: options.onProgress }),
        ...(options.onPersistUploadId !== undefined && {
          onPersistUploadId: options.onPersistUploadId,
        }),
        ...(options.signal !== undefined && { signal: options.signal }),
      });
    }

    const form = new FormData();
    form.append("file", blob, filename || defaultFilenameFor(blob.type));
    if (options.purpose) form.append("purpose", options.purpose);
    const req: RequestOptions = { method: "POST", body: form };
    if (options.signal) req.signal = options.signal;
    if (options.onProgress) req.onUploadProgress = options.onProgress;
    return this.client.request<FileObject>("/api/v1/files", req);
  }

  /** List files owned by the authenticated user, newest first. */
  async list(options: FileRequestOptions = {}): Promise<FileListResponse> {
    const req: RequestOptions = { method: "GET" };
    if (options.signal) req.signal = options.signal;
    return this.client.request<FileListResponse>("/api/v1/files", req);
  }

  /** Fetch metadata for a single file. Throws if the file does not exist or is owned by another user. */
  async retrieve(id: string, options: FileRequestOptions = {}): Promise<FileObject> {
    if (!id) throw new UnifiedError("invalid_input", "files.retrieve requires a non-empty id");
    const req: RequestOptions = { method: "GET" };
    if (options.signal) req.signal = options.signal;
    return this.client.request<FileObject>(`/api/v1/files/${encodeURIComponent(id)}`, req);
  }

  /**
   * Delete a file. Removes both the metadata row and the underlying blob.
   * Idempotent against follow-up retrieves (subsequent calls 404).
   *
   * Method named `del` because `delete` is a JavaScript reserved word in
   * some legacy contexts; `del` matches the convention used by other
   * OpenAI-compatible SDKs.
   */
  async del(id: string, options: FileRequestOptions = {}): Promise<FileDeleteResponse> {
    if (!id) throw new UnifiedError("invalid_input", "files.del requires a non-empty id");
    const req: RequestOptions = { method: "DELETE" };
    if (options.signal) req.signal = options.signal;
    return this.client.request<FileDeleteResponse>(`/api/v1/files/${encodeURIComponent(id)}`, req);
  }

  /**
   * Download the raw bytes of a previously uploaded file. The returned
   * `contentType` is the value stored at upload time (the same MIME echoed
   * by `retrieve(id).mime_type`); `filename` mirrors `retrieve(id).filename`.
   */
  async content(id: string, options: FileRequestOptions = {}): Promise<FileContent> {
    if (!id) throw new UnifiedError("invalid_input", "files.content requires a non-empty id");
    const req: RequestOptions = { method: "GET" };
    if (options.signal) req.signal = options.signal;
    const { bytes, contentType, headers } = await this.client.requestBinary(
      `/api/v1/files/${encodeURIComponent(id)}/content`,
      req,
    );
    const cd = headers["content-disposition"];
    const filename = parseContentDispositionFilename(cd);
    return filename ? { bytes, contentType, filename } : { bytes, contentType };
  }
}

import type { Core, RequestOptions } from "../core/core";
import { UnifiedError } from "../core/errors";

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

export interface FileUploadOptions {
  /** Override the multipart filename. Defaults to the source's name (if any), else a mime-based default. */
  filename?: string;
  /** Override the multipart content type. Defaults to the source's type, magic-byte sniff, or `application/octet-stream`. */
  contentType?: string;
  signal?: AbortSignal;
}

export interface FileUploadResponse {
  /** Stable id. Pass as `file_id` to images.edit, responses.create, chat.completions.create. */
  file_id: string;
  /** Time-limited signed URL (the backend currently expires it after ~1h). */
  image_url: string;
  /** Optional expiry timestamp, if the backend includes it. */
  expires_at?: string;
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
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
      bytes[3] === 0x38 && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    return "image/gif";
  }
  // RIFF....WEBP
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
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
    Buffer?: { from(s: string, enc: string): { buffer: ArrayBuffer; byteOffset: number; byteLength: number } };
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

async function normalise(source: FileUploadSource, opts: FileUploadOptions): Promise<NormalisedUpload> {
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
    const mime =
      (opts.contentType || mimeFromUrl || sniffMime(bytes) || DEFAULT_CT);
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

  // Cross-realm Blob — duck-type the Blob shape (arrayBuffer + numeric size).
  if (
    typeof source === "object" &&
    source !== null &&
    typeof (source as { arrayBuffer?: unknown }).arrayBuffer === "function" &&
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
 * Files resource. Wraps the unified-api file upload endpoint and returns a
 * stable `file_id` that can be passed to `images.edit`, `responses.create`,
 * and `chat.completions.create` in place of inline bytes.
 *
 * The upload endpoint is image-only today; non-image payloads will be rejected
 * by the backend.
 */
export class Files {
  constructor(private readonly client: Core) {}

  async upload(source: FileUploadSource, options: FileUploadOptions = {}): Promise<FileUploadResponse> {
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
    return this.client.request<FileUploadResponse>("/api/v1/images/uploads", req);
  }
}

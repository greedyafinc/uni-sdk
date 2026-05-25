// Multimodal content-part helpers.
//
// unified-api accepts inline multimodal payloads on every chat/responses/messages
// surface (see UNI-69). These helpers normalise the per-surface wire format so
// callers can pass a Blob/File/Buffer/Uint8Array/data URL/hosted URL/file_id
// without remembering whether OpenAI wants `image_url`, Anthropic wants
// `source.base64`, etc.
//
// Pure functions / pure factory class — no transport, no client dependency.

import { UnifiedError } from "../core/errors";

function inputError(message: string): UnifiedError {
  return new UnifiedError("invalid_input", message);
}

// ─── Input types ──────────────────────────────────────────────────────────────

/**
 * Anything we can turn into binary content + an optional mime type:
 *   - Blob/File          (browser, Node 18+)
 *   - Buffer/Uint8Array  (Node)
 *   - ArrayBuffer
 *   - string             (http(s) URL, data URL, or raw base64 — see `Source`)
 *   - { url }            (hosted URL — used verbatim, no fetch)
 *   - { data, mimeType } (raw base64 string + mime)
 *   - { fileId }         (provider Files-API id, passed through)
 */
export type MultimodalSource =
  | Blob
  | ArrayBuffer
  | Uint8Array
  | { url: string; mimeType?: string }
  | { data: string; mimeType: string }
  | { fileId: string; mimeType?: string }
  | string;

export type AudioFormat = "wav" | "mp3";

export interface PartOptions {
  /** Override the auto-detected mime type. */
  mimeType?: string;
  /** OpenAI image detail hint (chat / responses image parts only). */
  detail?: "auto" | "low" | "high";
  /** Filename hint sent to providers that expose it (responses input_file, chat file). */
  filename?: string;
}

export interface AudioPartOptions extends PartOptions {
  /** Audio format. Required for chat input_audio; auto-detected from mime if omitted. */
  format?: AudioFormat;
}

// ─── Public wire-shape types (sit alongside resource types) ───────────────────

export type ChatImagePart = {
  type: "image_url";
  image_url: { url: string; detail?: "auto" | "low" | "high" };
};
export type ChatAudioPart = {
  type: "input_audio";
  input_audio: { data: string; format: AudioFormat };
};
export type ChatVideoPart = { type: "video_url"; video_url: { url: string } };
export type ChatFilePart = {
  type: "file";
  file: { file_data?: string; file_url?: string; file_id?: string; filename?: string };
};

export type ResponsesImagePart = {
  type: "input_image";
  image_url?: string;
  file_id?: string;
  detail?: "auto" | "low" | "high";
};
export type ResponsesAudioPart = {
  type: "input_audio";
  input_audio: { data: string; format: AudioFormat };
};
export type ResponsesVideoPart = {
  type: "input_video";
  video_url?: string;
  file_id?: string;
};
export type ResponsesFilePart = {
  type: "input_file";
  file_data?: string;
  file_url?: string;
  file_id?: string;
  filename?: string;
};

export type MessagesImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
export type MessagesImagePart =
  | { type: "image"; source: { type: "base64"; media_type: MessagesImageMediaType; data: string } }
  | { type: "image"; source: { type: "url"; url: string } }
  | { type: "image"; source: { type: "file"; file_id: string } };

export type MessagesDocumentPart =
  | {
      type: "document";
      source: { type: "base64"; media_type: "application/pdf"; data: string };
    }
  | { type: "document"; source: { type: "url"; url: string } }
  | { type: "document"; source: { type: "file"; file_id: string } };

// ─── Internal: normalised bytes/url/id representation ─────────────────────────

interface Normalised {
  /** Mutually exclusive: exactly one of base64 / url / fileId is set. */
  base64?: string | undefined;
  url?: string | undefined;
  fileId?: string | undefined;
  mimeType?: string | undefined;
  filename?: string | undefined;
}

async function normaliseSource(source: MultimodalSource, opts: PartOptions): Promise<Normalised> {
  // Plain string — treat as URL (http(s) or data URL). Raw base64 strings are
  // ambiguous, so callers must pass them as { data, mimeType }.
  if (typeof source === "string") {
    if (isDataUrl(source) || isHttpUrl(source) || isGsUrl(source)) {
      return {
        url: source,
        mimeType: opts.mimeType ?? mimeFromDataUrl(source),
        filename: opts.filename,
      };
    }
    throw inputError(
      "string source must be an http(s) URL, data URL, or gs:// URL. " +
        "Pass raw base64 as `{ data, mimeType }` instead.",
    );
  }
  if (isFileIdInput(source)) {
    return {
      fileId: source.fileId,
      mimeType: opts.mimeType ?? source.mimeType,
      filename: opts.filename,
    };
  }
  if (isUrlInput(source)) {
    return { url: source.url, mimeType: opts.mimeType ?? source.mimeType, filename: opts.filename };
  }
  if (isRawBase64Input(source)) {
    return {
      base64: source.data,
      mimeType: opts.mimeType ?? source.mimeType,
      filename: opts.filename,
    };
  }

  // Binary inputs from here down.
  const bytes = await toBytes(source);
  const mime = opts.mimeType ?? detectMime(source, bytes) ?? undefined;
  return {
    base64: bytesToBase64(bytes),
    mimeType: mime,
    filename: opts.filename ?? filenameOf(source),
  };
}

function isFileIdInput(s: unknown): s is { fileId: string; mimeType?: string } {
  return (
    typeof s === "object" && s !== null && typeof (s as { fileId?: unknown }).fileId === "string"
  );
}
function isUrlInput(s: unknown): s is { url: string; mimeType?: string } {
  return typeof s === "object" && s !== null && typeof (s as { url?: unknown }).url === "string";
}
function isRawBase64Input(s: unknown): s is { data: string; mimeType: string } {
  return (
    typeof s === "object" &&
    s !== null &&
    typeof (s as { data?: unknown }).data === "string" &&
    typeof (s as { mimeType?: unknown }).mimeType === "string"
  );
}

// ─── Binary → bytes → base64 ──────────────────────────────────────────────────

async function toBytes(source: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  // Blob/File — both browser and Node 18+ implement arrayBuffer().
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    return new Uint8Array(await source.arrayBuffer());
  }
  throw inputError(
    "unsupported multimodal source; expected Blob/File/Buffer/Uint8Array/ArrayBuffer",
  );
}

function bytesToBase64(bytes: Uint8Array): string {
  // Prefer Buffer in Node — it's faster and handles arbitrary lengths cleanly.
  // Fall back to chunked btoa in browser/edge runtimes.
  const g = globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } };
  if (typeof g.Buffer !== "undefined") return g.Buffer.from(bytes).toString("base64");
  if (typeof btoa === "function") {
    let binary = "";
    // Chunk to stay under the argument-count limit on String.fromCharCode.
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const slice = bytes.subarray(i, i + CHUNK);
      binary += String.fromCharCode(...(slice as unknown as number[]));
    }
    return btoa(binary);
  }
  throw inputError("no base64 encoder available (neither Buffer nor btoa)");
}

// ─── Mime detection ───────────────────────────────────────────────────────────

const MAGIC: Array<{ mime: string; bytes: number[]; offset?: number }> = [
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  // WebP: "RIFF....WEBP"
  { mime: "image/webp", bytes: [0x57, 0x45, 0x42, 0x50], offset: 8 },
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mime: "audio/wav", bytes: [0x57, 0x41, 0x56, 0x45], offset: 8 }, // RIFF....WAVE
  { mime: "audio/mpeg", bytes: [0x49, 0x44, 0x33] }, // ID3 (MP3 with tag)
  { mime: "audio/mpeg", bytes: [0xff, 0xfb] }, // MP3 frame, no tag
  { mime: "audio/mpeg", bytes: [0xff, 0xf3] },
  { mime: "audio/mpeg", bytes: [0xff, 0xf2] },
  { mime: "video/mp4", bytes: [0x66, 0x74, 0x79, 0x70], offset: 4 }, // ....ftyp
  { mime: "video/webm", bytes: [0x1a, 0x45, 0xdf, 0xa3] },
];

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

function detectMime(source: Blob | ArrayBuffer | Uint8Array, bytes: Uint8Array): string | null {
  // 1. Blob/File carries its own type.
  if (typeof Blob !== "undefined" && source instanceof Blob && source.type) return source.type;
  // 2. File name extension (browser File or filename hint).
  const fname = filenameOf(source);
  if (fname) {
    const ext = fname.split(".").pop()?.toLowerCase();
    if (ext && EXT_MIME[ext]) return EXT_MIME[ext];
  }
  // 3. Magic bytes.
  for (const m of MAGIC) {
    if (matchMagic(bytes, m.bytes, m.offset ?? 0)) return m.mime;
  }
  return null;
}

function matchMagic(bytes: Uint8Array, sig: number[], offset: number): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

function filenameOf(source: unknown): string | undefined {
  // Browser File extends Blob with a `name`. Buffer/Uint8Array carry none.
  const n = (source as { name?: unknown }).name;
  return typeof n === "string" ? n : undefined;
}

function isDataUrl(s: string): boolean {
  return s.startsWith("data:");
}
function isHttpUrl(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}
function isGsUrl(s: string): boolean {
  return s.startsWith("gs://");
}
function mimeFromDataUrl(s: string): string | undefined {
  if (!isDataUrl(s)) return undefined;
  const m = s.match(/^data:([^;,]+)[;,]/);
  return m ? m[1] : undefined;
}

function dataUrlFor(n: Normalised, kind: "image" | "audio" | "video" | "file"): string {
  if (n.url) return n.url;
  if (n.base64 === undefined) {
    throw inputError(`cannot build ${kind} part: source had no bytes or URL`);
  }
  const mime = n.mimeType ?? defaultMimeFor(kind);
  return `data:${mime};base64,${n.base64}`;
}

function defaultMimeFor(kind: "image" | "audio" | "video" | "file"): string {
  switch (kind) {
    case "image":
      return "application/octet-stream";
    case "audio":
      return "audio/mpeg";
    case "video":
      return "video/mp4";
    case "file":
      return "application/octet-stream";
  }
}

// ─── Chat completions parts ───────────────────────────────────────────────────

export async function toChatImagePart(
  source: MultimodalSource,
  opts: PartOptions = {},
): Promise<ChatImagePart> {
  const n = await normaliseSource(source, opts);
  if (n.fileId) {
    throw inputError(
      "chat.completions image_url does not accept file_id. Use sdk.helpers.toResponsesImagePart " +
        "or sdk.helpers.toChatFilePart instead.",
    );
  }
  const part: ChatImagePart = { type: "image_url", image_url: { url: dataUrlFor(n, "image") } };
  if (opts.detail) part.image_url.detail = opts.detail;
  return part;
}

export async function toChatAudioPart(
  source: MultimodalSource,
  opts: AudioPartOptions = {},
): Promise<ChatAudioPart> {
  const n = await normaliseSource(source, opts);
  if (n.fileId || n.url) {
    throw inputError(
      "chat.completions input_audio requires inline base64. Use a Blob/Buffer/Uint8Array, " +
        "or for hosted audio use sdk.helpers.toChatFilePart.",
    );
  }
  if (n.base64 === undefined) {
    throw inputError("audio part requires bytes");
  }
  const format = opts.format ?? formatFromMime(n.mimeType);
  if (!format) {
    throw inputError("audio format could not be inferred; pass `{ format: 'wav' | 'mp3' }`");
  }
  return { type: "input_audio", input_audio: { data: n.base64, format } };
}

export async function toChatVideoPart(
  source: MultimodalSource,
  opts: PartOptions = {},
): Promise<ChatVideoPart> {
  const n = await normaliseSource(source, opts);
  if (n.fileId) {
    throw inputError(
      "chat.completions video_url does not accept file_id. Use sdk.helpers.toChatFilePart instead.",
    );
  }
  return { type: "video_url", video_url: { url: dataUrlFor(n, "video") } };
}

export async function toChatFilePart(
  source: MultimodalSource,
  opts: PartOptions = {},
): Promise<ChatFilePart> {
  const n = await normaliseSource(source, opts);
  const file: ChatFilePart["file"] = {};
  if (n.fileId) file.file_id = n.fileId;
  else if (n.url && isHttpUrl(n.url)) file.file_url = n.url;
  else file.file_data = dataUrlFor(n, "file");
  if (n.filename) file.filename = n.filename;
  return { type: "file", file };
}

// ─── Responses parts ──────────────────────────────────────────────────────────

export async function toResponsesImagePart(
  source: MultimodalSource,
  opts: PartOptions = {},
): Promise<ResponsesImagePart> {
  const n = await normaliseSource(source, opts);
  const part: ResponsesImagePart = { type: "input_image" };
  if (n.fileId) part.file_id = n.fileId;
  else part.image_url = dataUrlFor(n, "image");
  if (opts.detail) part.detail = opts.detail;
  return part;
}

export async function toResponsesAudioPart(
  source: MultimodalSource,
  opts: AudioPartOptions = {},
): Promise<ResponsesAudioPart> {
  // Audio on /responses uses the same shape as chat input_audio.
  return toChatAudioPart(source, opts);
}

export async function toResponsesVideoPart(
  source: MultimodalSource,
  opts: PartOptions = {},
): Promise<ResponsesVideoPart> {
  const n = await normaliseSource(source, opts);
  const part: ResponsesVideoPart = { type: "input_video" };
  if (n.fileId) part.file_id = n.fileId;
  else part.video_url = dataUrlFor(n, "video");
  return part;
}

export async function toResponsesFilePart(
  source: MultimodalSource,
  opts: PartOptions = {},
): Promise<ResponsesFilePart> {
  const n = await normaliseSource(source, opts);
  const part: ResponsesFilePart = { type: "input_file" };
  if (n.fileId) part.file_id = n.fileId;
  else if (n.url && isHttpUrl(n.url)) part.file_url = n.url;
  else part.file_data = dataUrlFor(n, "file");
  if (n.filename) part.filename = n.filename;
  return part;
}

// ─── Messages (Anthropic) parts ───────────────────────────────────────────────

const ANTHROPIC_IMAGE_MIME = new Set<MessagesImageMediaType>([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export async function toMessagesImagePart(
  source: MultimodalSource,
  opts: PartOptions = {},
): Promise<MessagesImagePart> {
  const n = await normaliseSource(source, opts);
  if (n.fileId) return { type: "image", source: { type: "file", file_id: n.fileId } };
  if (n.url && !isDataUrl(n.url)) return { type: "image", source: { type: "url", url: n.url } };
  // base64 path (covers both binary inputs and data URLs).
  const data = n.base64 ?? base64FromDataUrl(n.url);
  const mime = (n.mimeType ?? mimeFromDataUrl(n.url ?? "")) as MessagesImageMediaType | undefined;
  if (!mime || !ANTHROPIC_IMAGE_MIME.has(mime)) {
    throw inputError(
      `messages image requires media_type in ${[...ANTHROPIC_IMAGE_MIME].join(", ")}; got ${mime ?? "<unknown>"}`,
    );
  }
  if (!data) {
    throw inputError("messages image requires base64 data");
  }
  return { type: "image", source: { type: "base64", media_type: mime, data } };
}

export async function toMessagesDocumentPart(
  source: MultimodalSource,
  opts: PartOptions = {},
): Promise<MessagesDocumentPart> {
  const n = await normaliseSource(source, opts);
  if (n.fileId) return { type: "document", source: { type: "file", file_id: n.fileId } };
  if (n.url && !isDataUrl(n.url)) return { type: "document", source: { type: "url", url: n.url } };
  const data = n.base64 ?? base64FromDataUrl(n.url);
  const mime = n.mimeType ?? mimeFromDataUrl(n.url ?? "");
  if (mime !== "application/pdf") {
    throw inputError(`messages document requires application/pdf; got ${mime ?? "<unknown>"}`);
  }
  if (!data) {
    throw inputError("messages document requires base64 data");
  }
  return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
}

function base64FromDataUrl(url: string | undefined): string | undefined {
  if (!url || !isDataUrl(url)) return undefined;
  const i = url.indexOf(",");
  return i >= 0 ? url.slice(i + 1) : undefined;
}

function formatFromMime(mime: string | undefined): AudioFormat | undefined {
  if (!mime) return undefined;
  if (mime === "audio/wav" || mime === "audio/x-wav") return "wav";
  if (mime === "audio/mpeg" || mime === "audio/mp3") return "mp3";
  return undefined;
}

// ─── Public Helpers facade ────────────────────────────────────────────────────

/**
 * Stateless factory exposed as `sdk.helpers`. All methods mirror the free
 * functions exported above — keep them in sync.
 */
export class Helpers {
  toImagePart = toChatImagePart;
  toAudioPart = toChatAudioPart;
  toVideoPart = toChatVideoPart;
  toFilePart = toChatFilePart;

  toChatImagePart = toChatImagePart;
  toChatAudioPart = toChatAudioPart;
  toChatVideoPart = toChatVideoPart;
  toChatFilePart = toChatFilePart;

  toResponsesImagePart = toResponsesImagePart;
  toResponsesAudioPart = toResponsesAudioPart;
  toResponsesVideoPart = toResponsesVideoPart;
  toResponsesFilePart = toResponsesFilePart;

  toMessagesImagePart = toMessagesImagePart;
  toMessagesDocumentPart = toMessagesDocumentPart;
}

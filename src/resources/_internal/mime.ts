// Shared MIME detection for upload/multimodal resources (helpers.ts,
// files.ts). Browser-safe: pure byte/string inspection, no node imports.

// Order matters: more specific signatures first.
const MAGIC: Array<{ mime: string; bytes: number[]; offset?: number }> = [
  { mime: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: "application/pdf", bytes: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  { mime: "audio/mpeg", bytes: [0x49, 0x44, 0x33] }, // ID3 (MP3 with tag)
  { mime: "audio/mpeg", bytes: [0xff, 0xfb] }, // MP3 frame, no tag
  { mime: "audio/mpeg", bytes: [0xff, 0xf3] },
  { mime: "audio/mpeg", bytes: [0xff, 0xf2] },
  { mime: "video/webm", bytes: [0x1a, 0x45, 0xdf, 0xa3] },
];

// "RIFF....WEBP" and "RIFF....WAVE" share the RIFF prefix; resolve them by
// matching both the RIFF header AND the form-type at offset 8 so unrelated
// buffers that happen to contain "WEBP"/"WAVE" at offset 8 don't false-match.
const RIFF = [0x52, 0x49, 0x46, 0x46];
const WEBP_FORM = [0x57, 0x45, 0x42, 0x50];
const WAVE_FORM = [0x57, 0x41, 0x56, 0x45];

// MP4 / M4A / MOV are all ISO-BMFF containers identified by an `ftyp` box at
// offset 4; distinguish by the brand at offset 8.
//
// IMPORTANT: only brands that are UNIQUELY audio-only go in M4A_BRANDS.
// `mp42` and `isom` are shared by AAC-in-MP4 audio AND H.264 video — they
// cannot disambiguate from magic bytes alone. A bare-bytes M4A with brand
// mp42 will resolve to video/mp4 here; callers should pass a filename hint
// or `{ format: "mp3" }` for those cases (still rare in browser file inputs
// because the File API surfaces .type/.name).
const FTYP = [0x66, 0x74, 0x79, 0x70];
const MP4_BRANDS = new Set(["mp41", "mp42", "isom", "iso2", "avc1", "dash"]);
const M4A_BRANDS = new Set(["M4A ", "M4B "]);
const MOV_BRANDS = new Set(["qt  "]);

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

/**
 * Bytes-only magic sniffer (images, PDF, audio, video). Used directly by
 * `files.create`, and as the final stage of {@link detectMime}. Deliberately
 * ignores filenames — callers that want extension hints use `detectMime`.
 */
export function sniffMime(bytes: Uint8Array): string | null {
  // Magic bytes — order-independent, exact signatures.
  for (const m of MAGIC) {
    if (matchMagic(bytes, m.bytes, m.offset ?? 0)) return m.mime;
  }
  // RIFF containers — disambiguate by form-type at offset 8.
  if (matchMagic(bytes, RIFF, 0)) {
    if (matchMagic(bytes, WEBP_FORM, 8)) return "image/webp";
    if (matchMagic(bytes, WAVE_FORM, 8)) return "audio/wav";
  }
  // ISO-BMFF (ftyp) — disambiguate by brand at offset 8.
  if (matchMagic(bytes, FTYP, 4) && bytes.length >= 12) {
    const brand = String.fromCharCode(bytes[8] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0, bytes[11] ?? 0);
    if (M4A_BRANDS.has(brand)) return "audio/mp4";
    if (MOV_BRANDS.has(brand)) return "video/quicktime";
    if (MP4_BRANDS.has(brand)) return "video/mp4";
    // Unknown brand — default to mp4 (most common) but only when ftyp matched.
    return "video/mp4";
  }
  return null;
}

/**
 * Full detector: Blob `type` → filename extension → magic bytes
 * ({@link sniffMime}).
 */
export function detectMime(source: unknown, bytes: Uint8Array): string | null {
  // 1. Blob/File carries its own type.
  if (typeof Blob !== "undefined" && source instanceof Blob && source.type) return source.type;
  // Cross-realm Blob — duck-type the `type` property.
  if (
    typeof source === "object" &&
    source !== null &&
    typeof (source as { arrayBuffer?: unknown }).arrayBuffer === "function"
  ) {
    const t = (source as { type?: unknown }).type;
    if (typeof t === "string" && t.length > 0) return t;
  }
  // 2. File name extension (browser File or filename hint).
  const fname = filenameOf(source);
  if (fname) {
    const ext = fname.split(".").pop()?.toLowerCase();
    if (ext && EXT_MIME[ext]) return EXT_MIME[ext];
  }
  // 3. Magic bytes.
  return sniffMime(bytes);
}

function matchMagic(bytes: Uint8Array, sig: number[], offset: number): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (bytes[offset + i] !== sig[i]) return false;
  return true;
}

/** Filename carried by the source, if any (browser File extends Blob with `name`). */
export function filenameOf(source: unknown): string | undefined {
  // Buffer/Uint8Array carry none.
  if (source === null || source === undefined) return undefined;
  if (typeof source !== "object") return undefined;
  const n = (source as { name?: unknown }).name;
  return typeof n === "string" ? n : undefined;
}

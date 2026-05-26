import { Buffer } from "node:buffer";
import type { Cassette, CassetteInteraction } from "./cassette";
import { saveCassette } from "./cassette";

// Content types we treat as text-safe to embed in the JSON cassette. Anything
// outside this set (audio/*, video/*, image/*, application/octet-stream, ...)
// is captured as base64 so the bytes round-trip losslessly.
//
// Match by exact MIME, by `<type>/` prefix (e.g. `text/` matches text/markdown
// and any other text/* subtype), or by structured-syntax suffix (`+json` and
// `+xml` per RFC 6838 — covers application/problem+json, vnd.api+json, etc.).
// The old recorder used `.includes("application/json")` which silently caught
// `+json` variants; keep that breadth so error cassettes stay readable.
const TEXT_EXACT = new Set<string>([
  "application/json",
  "application/xml",
  "application/x-www-form-urlencoded",
]);
const TEXT_PREFIXES = ["text/"] as const;
const TEXT_SUFFIXES = ["+json", "+xml"] as const;

// Recursive redactor for recorded response bodies. Cassettes are checked
// into git (so contributors can run replay-mode tests without credentials),
// which means anything that looks like a credential or unforgeable URL has
// to be scrubbed before persistence. Today this covers Supabase signed
// storage URLs (the `?token=<HS256 JWT>` query param leaks the storage
// signing key id and the exact bucket path) and any bearer tokens that
// might appear in echoed-back payloads.
//
// Replay mode never re-fetches these URLs (the replay server returns
// recorded JSON verbatim, matched by method+path only), so a placeholder
// host is fine for replay assertions — production callers always re-issue
// uploads to get fresh URLs.
const SUPABASE_SIGNED_URL_RE =
  /https?:\/\/[a-z0-9-]+\.supabase\.co\/storage\/v1\/object\/sign\/[^"'\s]+/gi;
const BEARER_RE = /(Bearer\s+)([A-Za-z0-9._-]{20,})/gi;

function redactString(s: string): string {
  return s
    .replace(
      SUPABASE_SIGNED_URL_RE,
      "https://example.test/storage/v1/object/sign/REDACTED?token=REDACTED",
    )
    .replace(BEARER_RE, "$1REDACTED");
}

function redactSensitive(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactSensitive(v);
    }
    return out;
  }
  return value;
}

function isTextContentType(ct: string): boolean {
  const norm = ct.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!norm) return true; // empty content-type — treat as text (legacy)
  if (TEXT_EXACT.has(norm)) return true;
  if (TEXT_PREFIXES.some((p) => norm.startsWith(p))) return true;
  if (TEXT_SUFFIXES.some((s) => norm.endsWith(s))) return true;
  return false;
}

export interface Recorder {
  baseUrl: string;
  /** Begin recording into the given cassette name. Overwrites on stop(). */
  start: (cassetteName: string) => void;
  /** Flush the active cassette to disk. */
  flush: () => void;
  stop: () => Promise<void>;
}

export interface RecorderOptions {
  /** URL of the live unified-api (default http://127.0.0.1:3000). */
  upstream?: string;
}

export async function startRecorder(opts: RecorderOptions = {}): Promise<Recorder> {
  const upstream = opts.upstream ?? "http://127.0.0.1:3000";
  let activeName: string | undefined;
  let interactions: CassetteInteraction[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const incomingUrl = new URL(req.url);
      // Read as bytes — multipart uploads contain binary payloads (PNG/JPEG/
      // WEBP magic bytes have the high bit set). `req.text()` would lossily
      // UTF-8-decode them, replacing 0x89/0xae/etc. with U+FFFD before we
      // forward to upstream, breaking the file's signature.
      const reqBytes = new Uint8Array(await req.arrayBuffer());
      const reqCt = (req.headers.get("content-type") ?? "").toLowerCase();
      const reqIsText = isTextContentType(reqCt);
      let parsedBody: unknown = null;
      if (reqBytes.length > 0) {
        if (reqIsText) {
          const text = new TextDecoder().decode(reqBytes);
          try {
            parsedBody = JSON.parse(text);
          } catch {
            parsedBody = text;
          }
        } else {
          // Non-text request body (multipart/form-data, binary uploads) — we
          // don't record the raw bytes in the cassette today, but note the
          // type so cassette readers can see it was non-empty.
          parsedBody = { _binary: reqBytes.byteLength, contentType: reqCt };
        }
      }

      const targetUrl = new URL(incomingUrl.pathname + incomingUrl.search, upstream);
      const headers = new Headers(req.headers);
      headers.delete("host");

      const init: RequestInit = { method: req.method, headers };
      if (reqBytes.length > 0) init.body = reqBytes;
      const upstreamRes = await fetch(targetUrl, init);

      const respHeaders: Record<string, string> = {};
      upstreamRes.headers.forEach((v, k) => {
        // Bun's fetch auto-decompresses the body before handing it to
        // arrayBuffer(), so the upstream content-encoding (gzip/br/deflate)
        // would lie about the bytes we record. Drop it. content-length
        // similarly describes the *compressed* size and won't match the
        // decoded bytes we replay.
        const lower = k.toLowerCase();
        if (lower === "content-encoding" || lower === "content-length") return;
        respHeaders[k] = v;
      });

      const ct = respHeaders["content-type"] ?? "";
      const isJson = ct.includes("application/json");
      const isSse = ct.includes("text/event-stream");
      const isText = isTextContentType(ct);

      // For binary responses (audio/video bytes) we must keep the raw bytes —
      // arrayBuffer() once, then both record (base64) and replay (passthrough).
      const respBuf = await upstreamRes.arrayBuffer();
      const respBytes = new Uint8Array(respBuf);

      let recordedBody: unknown;
      let recordedBase64: string | undefined;
      if (isText) {
        const decoded = new TextDecoder().decode(respBytes);
        if (isJson && decoded) {
          try {
            recordedBody = redactSensitive(JSON.parse(decoded));
          } catch {
            recordedBody = redactString(decoded);
          }
        } else {
          recordedBody = redactString(decoded);
        }
      } else {
        recordedBase64 = Buffer.from(respBytes).toString("base64");
      }

      if (activeName) {
        interactions.push({
          request: {
            method: req.method,
            path: incomingUrl.pathname,
            // Apply the same redactor to request bodies — when a caller
            // echoes a previous response's signed URL back into a new
            // request (e.g. `responses.create({ input_image: { image_url } })`
            // with the upload's returned URL), the cassette would otherwise
            // leak the URL in the request payload even though the response
            // is scrubbed.
            body: redactSensitive(parsedBody),
          },
          response: {
            status: upstreamRes.status,
            headers: respHeaders,
            ...(recordedBase64 !== undefined
              ? { bodyBase64: recordedBase64 }
              : { body: recordedBody }),
            ...(isSse ? { stream: true } : {}),
          },
        });
      }

      return new Response(respBytes, {
        status: upstreamRes.status,
        headers: respHeaders,
      });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    start(cassetteName: string) {
      activeName = cassetteName;
      interactions = [];
    },
    flush() {
      if (!activeName) return;
      const bad = interactions.filter((i) => i.response.status >= 400);
      if (bad.length > 0) {
        const summary = bad
          .map((i) => `${i.request.method} ${i.request.path} → ${i.response.status}`)
          .join("\n  ");
        throw new Error(
          `Refusing to save cassette '${activeName}': ${bad.length} non-2xx response(s) recorded. Fix the upstream and re-record.\n  ${summary}`,
        );
      }
      const cassette: Cassette = { interactions };
      saveCassette(activeName, cassette);
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}

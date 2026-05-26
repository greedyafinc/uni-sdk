import type { Core, RequestOptions } from "../core/core";

// ── Shared types ───────────────────────────────────────────────────────────────

export type VideoStatus = "queued" | "in_progress" | "completed" | "failed";
export type VideoSeconds = "4" | "6" | "8";
export type VideoSize = "1280x720" | "720x1280" | "1920x1080" | "1080x1920" | (string & {});

export interface VideoError {
  code: string;
  message: string;
}

export interface VideoObject {
  /** Full Vertex operation name; opaque to clients but must be passed verbatim
   * to retrieve/content. URL encoding is handled by the SDK. */
  id: string;
  object: "video";
  model: string;
  status: VideoStatus;
  progress: number;
  created_at: number | null;
  completed_at: number | null;
  expires_at: number | null;
  seconds: string | null;
  size: string | null;
  error: VideoError | null;
  remixed_from_video_id: string | null;
}

// ── Create ─────────────────────────────────────────────────────────────────────

export interface VideoCreateParams {
  prompt: string;
  model: string;
  seconds?: VideoSeconds;
  size?: VideoSize;
  generate_audio?: boolean;
  /** Optional reference image for image-to-video. Browser: `File`/`Blob`.
   * Node 20+: `Blob`/`File` from `node:buffer`. PNG / JPEG / WebP, ≤ 25 MB. */
  input_reference?: Blob;
  /** Filename for the multipart part when `input_reference` is provided. */
  input_reference_filename?: string;
}

// ── Content (binary) ───────────────────────────────────────────────────────────

export interface VideoContent {
  bytes: ArrayBuffer;
  /** Provider-reported MIME type, typically "video/mp4". */
  mimeType: string;
}

// ── Polling ────────────────────────────────────────────────────────────────────

export interface VideoWaitOptions {
  /** Poll interval in ms. Default 5000. */
  pollIntervalMs?: number;
  /** Hard cap in ms. Throws on timeout. Default 600000 (10 min). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface VideoRequestOptions {
  signal?: AbortSignal;
}

const ACCEPTED_VIDEO_TYPES = ["video/"] as const;

// ── Resource ───────────────────────────────────────────────────────────────────

/**
 * Operation names from Vertex contain slashes and colons. Encode the full id
 * as a single path segment so it survives transport without being parsed by
 * the gateway router as multiple segments.
 */
function encodeVideoId(id: string): string {
  return encodeURIComponent(id);
}

export class Videos {
  constructor(private readonly client: Core) {}

  /**
   * Kick off a video generation job. Returns immediately with `status: "queued"`;
   * poll {@link retrieve} (or use {@link waitUntilReady}) until `status` is
   * `completed` or `failed`, then call {@link content} to fetch the bytes.
   */
  create(params: VideoCreateParams, options: VideoRequestOptions = {}): Promise<VideoObject> {
    // Always send multipart/form-data. unified-api's videos route declares
    // its body schema with `t.File` (for the optional input_reference), and
    // its server-side test suite (modules/videos/index.test.ts) only
    // exercises multipart. Going JSON when input_reference is absent would
    // hit an untested code path through Elysia's body parser — and a fragile
    // one, because the Elysia + t.File combination historically requires
    // multipart even when the file field is optional. Sending multipart
    // unconditionally aligns the SDK with the contract unified-api actually
    // tests.
    const form = new FormData();
    form.append("prompt", params.prompt);
    form.append("model", params.model);
    if (params.seconds !== undefined) form.append("seconds", params.seconds);
    if (params.size !== undefined) form.append("size", params.size);
    if (params.generate_audio !== undefined) {
      form.append("generate_audio", String(params.generate_audio));
    }
    if (params.input_reference) {
      // `||` (not `??`) so empty-string filenames also fall back — synthesized
      // browser Blobs commonly produce `name === ""`.
      form.append(
        "input_reference",
        params.input_reference,
        params.input_reference_filename || "reference.png",
      );
    }
    const req: RequestOptions = { method: "POST", body: form };
    if (options.signal) req.signal = options.signal;
    return this.client.request<VideoObject>("/api/v1/videos", req);
  }

  retrieve(videoId: string, options: VideoRequestOptions = {}): Promise<VideoObject> {
    const req: RequestOptions = { method: "GET" };
    if (options.signal) req.signal = options.signal;
    return this.client.request<VideoObject>(`/api/v1/videos/${encodeVideoId(videoId)}`, req);
  }

  /**
   * Fetch the rendered video bytes. The job MUST be `completed`; calling this
   * before completion surfaces the upstream 409 as a `UnifiedAIError`.
   */
  content(videoId: string, options: VideoRequestOptions = {}): Promise<VideoContent> {
    // Accept any video/* subtype. Vertex Veo currently emits video/mp4, but
    // pinning that exact type would break future providers (webm, etc.).
    // Rejecting non-video content types defends against gateway error pages
    // being returned as bytes (see requestBinary acceptedContentTypes).
    const req: RequestOptions = { method: "GET", acceptedContentTypes: ACCEPTED_VIDEO_TYPES };
    if (options.signal) req.signal = options.signal;
    return this.client
      .requestBinary(`/api/v1/videos/${encodeVideoId(videoId)}/content`, req)
      .then((r) => ({ bytes: r.bytes, mimeType: r.contentType || "video/mp4" }));
  }

  /**
   * Poll {@link retrieve} until `status` is `completed` or `failed`. Returns
   * the final {@link VideoObject}; the caller is expected to check `status`
   * (a failed job is returned, not thrown — the HTTP call succeeded).
   *
   * Throws if the poll exceeds `timeoutMs` or the `signal` aborts. Pass a
   * generous `timeoutMs` — Veo renders can take a few minutes.
   */
  async waitUntilReady(videoId: string, options: VideoWaitOptions = {}): Promise<VideoObject> {
    const timeoutMs = options.timeoutMs ?? 600_000;
    const interval = options.pollIntervalMs ?? 5_000;
    const deadline = Date.now() + timeoutMs;

    for (;;) {
      if (options.signal?.aborted) {
        // DOMException with name "AbortError" matches what fetch throws on
        // aborted signals, so callers can use the same catch shape.
        const err = new Error("Video poll aborted");
        err.name = "AbortError";
        throw err;
      }
      // Check the deadline BEFORE issuing a retrieve. Otherwise a slow
      // retrieve (or any retrieve at all when timeoutMs <= retrieve latency)
      // burns one extra network round-trip past the user's deadline.
      if (Date.now() >= deadline) {
        throw new Error(`Video ${videoId} did not reach a terminal state within ${timeoutMs}ms`);
      }
      const reqOpts: VideoRequestOptions = {};
      if (options.signal) reqOpts.signal = options.signal;
      const v = await this.retrieve(videoId, reqOpts);
      if (v.status === "completed" || v.status === "failed") return v;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `Video ${videoId} did not reach a terminal state within ${timeoutMs}ms (last status: ${v.status})`,
        );
      }
      await sleep(Math.min(interval, remaining), options.signal);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      const err = new Error("Aborted");
      err.name = "AbortError";
      reject(err);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

import type { Core, RequestOptions } from "../core/core";

// ── Shared types ───────────────────────────────────────────────────────────────

export type ImageSize =
  | "auto"
  | "256x256"
  | "512x512"
  | "1024x1024"
  | "1024x1536"
  | "1536x1024"
  | "1024x1792"
  | "1792x1024"
  | (string & {});

export type ImageBackground = "transparent" | "opaque" | "auto";
export type ImageOutputFormat = "png" | "jpeg" | "webp";
export type ImageQuality = "standard" | "hd" | "low" | "medium" | "high" | "auto";
export type ImageResponseFormat = "url" | "b64_json";
export type ImageStyle = "vivid" | "natural";
export type ImageModeration = "low" | "auto";

/**
 * Reference to a previously-uploaded image. Used by `images.edit` for the
 * `images` and `mask` fields. Provide exactly one of `file_id` or `image_url`.
 *
 * **Prefer `image_url`** today: `file_id` values returned by
 * `sdk.files.upload()` are not yet resolved server-side and will be rejected
 * by upstream providers with "Failed to decode image data". `image_url`
 * (the signed URL from the same upload response) works on every provider.
 */
export interface ImageReference {
  /**
   * Provider-issued file id (OpenAI `file-...`). **Not currently compatible**
   * with `file_id` values returned by `sdk.files.upload()` — see note on
   * {@link ImageReference}. Pass `image_url` instead.
   */
  file_id?: string;
  image_url?: string;
}

// ── Generate ───────────────────────────────────────────────────────────────────

export interface ImageGenerateParams {
  prompt: string;
  model?: string;
  n?: number;
  size?: ImageSize;
  background?: ImageBackground;
  moderation?: ImageModeration;
  output_compression?: number;
  output_format?: ImageOutputFormat;
  partial_images?: number;
  quality?: ImageQuality;
  response_format?: ImageResponseFormat;
  style?: ImageStyle;
  user?: string;
  conversation_id?: string;
}

// ── Edit ───────────────────────────────────────────────────────────────────────

export interface ImageEditParams {
  images: ImageReference[];
  prompt: string;
  mask?: ImageReference;
  model?: string;
  n?: number;
  size?: Extract<ImageSize, "auto" | "1024x1024" | "1024x1536" | "1536x1024">;
  background?: ImageBackground;
  input_fidelity?: "high" | "low";
  moderation?: ImageModeration;
  output_compression?: number;
  output_format?: ImageOutputFormat;
  partial_images?: number;
  quality?: Exclude<ImageQuality, "standard" | "hd">;
  user?: string;
  conversation_id?: string;
}

// ── Variation (multipart) ──────────────────────────────────────────────────────

export interface ImageVariationParams {
  /** Source image. Browser: `File` or `Blob`. Node 20+: `Blob`/`File` from the
   * built-in `node:buffer` module also works since `globalThis.FormData` is
   * standards-compliant. */
  image: Blob;
  /** Optional filename for the multipart part. Defaults to "image.png". */
  filename?: string;
  n?: number;
  size?: "256x256" | "512x512" | "1024x1024";
  response_format?: ImageResponseFormat;
  user?: string;
  conversation_id?: string;
}

// ── Upload (multipart) ─────────────────────────────────────────────────────────

export interface ImageUploadParams {
  /** Source image. Browser: `File` or `Blob`. */
  file: Blob;
  /** Optional filename for the multipart part. Defaults to "image.png". */
  filename?: string;
}

export interface ImageUploadResponse {
  /** Stable ID for the uploaded file. */
  file_id: string;
  /** Time-limited signed URL — pass back to `images.edit` as `image_url`. */
  image_url: string;
}

// ── Response ───────────────────────────────────────────────────────────────────

export interface ImageData {
  /** Present when `response_format: "b64_json"` (the unified-api default). */
  b64_json?: string;
  /** Present when the provider returned a URL. */
  url?: string;
  revised_prompt?: string;
  /** Stable ID assigned by unified-api persistence (when enabled). */
  image_id?: string;
  /** Time-limited signed URL for the persisted image. */
  signed_url?: string;
}

export interface ImageUsage {
  input_tokens: number;
  input_tokens_details: { image_tokens: number; text_tokens: number };
  output_tokens: number;
  total_tokens: number;
  output_tokens_details?: { image_tokens: number; text_tokens: number };
}

export interface ImageResponse {
  created: number;
  data?: ImageData[];
  background?: "transparent" | "opaque";
  output_format?: ImageOutputFormat;
  quality?: "low" | "medium" | "high";
  size?: "1024x1024" | "1024x1536" | "1536x1024";
  usage?: ImageUsage;
}

export interface ImageRequestOptions {
  signal?: AbortSignal;
}

// ── Resource ───────────────────────────────────────────────────────────────────

export class Images {
  constructor(private readonly client: Core) {}

  generate(params: ImageGenerateParams, options: ImageRequestOptions = {}): Promise<ImageResponse> {
    const req: RequestOptions = { method: "POST", body: params };
    if (options.signal) req.signal = options.signal;
    return this.client.request<ImageResponse>("/api/v1/images/generations", req);
  }

  edit(params: ImageEditParams, options: ImageRequestOptions = {}): Promise<ImageResponse> {
    const req: RequestOptions = { method: "POST", body: params };
    if (options.signal) req.signal = options.signal;
    return this.client.request<ImageResponse>("/api/v1/images/edits", req);
  }

  upload(
    params: ImageUploadParams,
    options: ImageRequestOptions = {},
  ): Promise<ImageUploadResponse> {
    const form = new FormData();
    // `||` (not `??`) so empty-string filenames also fall back to the default —
    // some browser File sources (clipboard paste, drag-drop synth Blobs) produce
    // `name === ""`, which would otherwise send a multipart part with no name.
    form.append("file", params.file, params.filename || "image.png");
    const req: RequestOptions = { method: "POST", body: form };
    if (options.signal) req.signal = options.signal;
    return this.client.request<ImageUploadResponse>("/api/v1/images/uploads", req);
  }

  createVariation(
    params: ImageVariationParams,
    options: ImageRequestOptions = {},
  ): Promise<ImageResponse> {
    const form = new FormData();
    form.append("image", params.image, params.filename ?? "image.png");
    if (params.n !== undefined) form.append("n", String(params.n));
    if (params.size !== undefined) form.append("size", params.size);
    if (params.response_format !== undefined)
      form.append("response_format", params.response_format);
    if (params.user !== undefined) form.append("user", params.user);
    if (params.conversation_id !== undefined)
      form.append("conversation_id", params.conversation_id);
    const req: RequestOptions = { method: "POST", body: form };
    if (options.signal) req.signal = options.signal;
    return this.client.request<ImageResponse>("/api/v1/images/variations", req);
  }
}

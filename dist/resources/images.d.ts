import type { Core } from "../core/core.js";
export type ImageSize = "auto" | "256x256" | "512x512" | "1024x1024" | "1024x1536" | "1536x1024" | "1024x1792" | "1792x1024" | (string & {});
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
 * Either form works — `file_id` values returned by `sdk.files.upload()` and
 * `sdk.files.create()` are resolved to signed URLs server-side at request
 * time, and `image_url` from the `upload()` response is the same signed URL
 * passed through directly.
 */
export interface ImageReference {
    /**
     * Gateway file id from `sdk.files.upload()` / `sdk.files.create()`, or a
     * provider-issued id (e.g. OpenAI `file-...`). Mutually exclusive with
     * `image_url`.
     */
    file_id?: string;
    image_url?: string;
}
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
    input_tokens_details: {
        image_tokens: number;
        text_tokens: number;
    };
    output_tokens: number;
    total_tokens: number;
    output_tokens_details?: {
        image_tokens: number;
        text_tokens: number;
    };
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
    /**
     * Opt into the client's in-memory response cache. Honored only by
     * `generate` — `edit`, `upload`, and `createVariation` mutate or upload
     * and aren't sensible to cache.
     */
    cache?: boolean;
}
export declare class Images {
    private readonly client;
    constructor(client: Core);
    generate(params: ImageGenerateParams, options?: ImageRequestOptions): Promise<ImageResponse>;
    edit(params: ImageEditParams, options?: ImageRequestOptions): Promise<ImageResponse>;
    upload(params: ImageUploadParams, options?: ImageRequestOptions): Promise<ImageUploadResponse>;
    createVariation(params: ImageVariationParams, options?: ImageRequestOptions): Promise<ImageResponse>;
}
//# sourceMappingURL=images.d.ts.map
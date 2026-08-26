import type { Core } from "../core/core.js";
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
export interface VideoContent {
    bytes: ArrayBuffer;
    /** Provider-reported MIME type, typically "video/mp4". */
    mimeType: string;
}
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
export declare class Videos {
    private readonly client;
    constructor(client: Core);
    /**
     * Kick off a video generation job. Returns immediately with `status: "queued"`;
     * poll {@link retrieve} (or use {@link waitUntilReady}) until `status` is
     * `completed` or `failed`, then call {@link content} to fetch the bytes.
     */
    create(params: VideoCreateParams, options?: VideoRequestOptions): Promise<VideoObject>;
    retrieve(videoId: string, options?: VideoRequestOptions): Promise<VideoObject>;
    /**
     * Fetch the rendered video bytes. The job MUST be `completed`; calling this
     * before completion surfaces the upstream 409 as a `UnifiedAIError`.
     */
    content(videoId: string, options?: VideoRequestOptions): Promise<VideoContent>;
    /**
     * Poll {@link retrieve} until `status` is `completed` or `failed`. Returns
     * the final {@link VideoObject}; the caller is expected to check `status`
     * (a failed job is returned, not thrown — the HTTP call succeeded).
     *
     * Throws if the poll exceeds `timeoutMs` or the `signal` aborts. Pass a
     * generous `timeoutMs` — Veo renders can take a few minutes.
     */
    waitUntilReady(videoId: string, options?: VideoWaitOptions): Promise<VideoObject>;
}
//# sourceMappingURL=videos.d.ts.map
import type { Core } from "../core/core.js";
export type AudioResponseFormat = "mp3" | "wav" | "flac" | "opus" | "aac" | "pcm";
export interface AudioSpeechParams {
    model: string;
    /** Text to synthesize. Capped at 4096 chars by unified-api. */
    input: string;
    voice?: string;
    response_format?: AudioResponseFormat;
    /** Playback speed multiplier; provider-dependent. Range 0.25–4.0. */
    speed?: number;
    language?: string;
    /**
     * Non-OpenAI extension. When set, unified-api persists the generated clip to
     * the user's audio library, linked to this conversation, so first-party
     * clients can list and replay it later. Omitted → no persistence side-effect
     * (pure OpenAI-compatible streaming). The response is binary either way.
     */
    conversation_id?: string;
}
export interface AudioSpeechResponse {
    /** Raw synthesized audio bytes. */
    audio: ArrayBuffer;
    /** Server-reported MIME type (e.g. "audio/mpeg"). The byte format does NOT
     * necessarily match `response_format` — providers normalize on their side. */
    contentType: string;
}
export interface AudioRequestOptions {
    signal?: AbortSignal;
}
export declare class Audio {
    private readonly client;
    constructor(client: Core);
    /**
     * Synthesize speech from text. Returns binary audio bytes plus the
     * server-reported content-type. The caller decides how to consume them —
     * stream to disk in Node, hand to an `<audio>` element via Blob in the
     * browser, etc.
     */
    speech(params: AudioSpeechParams, options?: AudioRequestOptions): Promise<AudioSpeechResponse>;
}
//# sourceMappingURL=audio.d.ts.map
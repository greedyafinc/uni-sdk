import type { Core, RequestOptions } from "../core/core";

// ── Speech ─────────────────────────────────────────────────────────────────────

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

// Accept any audio/* subtype plus application/octet-stream (the unified-api
// route uses octet-stream for raw PCM since there's no IANA-registered MIME
// for it). Anything else — JSON envelopes, HTML error pages — is rejected.
const ACCEPTED_AUDIO_TYPES = ["audio/", "application/octet-stream"] as const;

// ── Resource ───────────────────────────────────────────────────────────────────

export class Audio {
  constructor(private readonly client: Core) {}

  /**
   * Synthesize speech from text. Returns binary audio bytes plus the
   * server-reported content-type. The caller decides how to consume them —
   * stream to disk in Node, hand to an `<audio>` element via Blob in the
   * browser, etc.
   */
  speech(
    params: AudioSpeechParams,
    options: AudioRequestOptions = {},
  ): Promise<AudioSpeechResponse> {
    // Allowlist matches what unified-api's /audio/speech route can emit
    // (see src/modules/audio/service.ts AUDIO_MIME_ALLOWLIST). Anything
    // else from the gateway is treated as a misconfigured response.
    const req: RequestOptions = {
      method: "POST",
      body: params,
      acceptedContentTypes: ACCEPTED_AUDIO_TYPES,
    };
    if (options.signal) req.signal = options.signal;
    return this.client.requestBinary("/api/v1/audio/speech", req).then((r) => ({
      audio: r.bytes,
      contentType: r.contentType,
    }));
  }
}

import type { Core } from "../core.js";
import { type StreamUsageExtractor, UnifiedStream } from "./stream.js";
export interface SSEFrameYield<TEvent> {
    event: TEvent;
    /** End the stream after yielding this event (e.g. `message_stop`). */
    terminal?: boolean;
}
export interface SSEStreamConfig<TEvent, TStream extends UnifiedStream<TEvent>> {
    client: Core;
    /** POST path on unified-api (e.g. `/v1/messages`). */
    path: string;
    /**
     * Request body. `compression` falls back to the client-level default when
     * unset; an explicit `false` overrides a client default of `true`.
     */
    params: {
        compression?: boolean;
    };
    /** Caller-supplied abort signal, linked to the stream's own controller. */
    signal?: AbortSignal | undefined;
    /**
     * Raw `data:` payload that cleanly terminates the stream before JSON
     * parsing (chat.completions' `[DONE]`). Frames that fail to JSON-parse are
     * silently skipped regardless.
     */
    doneSentinel?: string;
    /**
     * Interpret one JSON-parsed frame. `eventName` is the SSE `event:` field
     * when present. Return the event to yield (with `terminal: true` to end the
     * stream after it), `null` to skip the frame, or throw a `UnifiedError`
     * subclass for in-band error frames — typed throws pass through to the
     * consumer unchanged.
     */
    interpret: (parsed: Record<string, unknown>, eventName: string | undefined) => SSEFrameYield<TEvent> | null;
    /** Per-resource usage extraction; see `StreamUsageExtractor`. */
    usage?: StreamUsageExtractor<TEvent> | undefined;
    /**
     * UnifiedStream subclass to construct (e.g. `MessageStream`). Defaults to
     * `UnifiedStream` itself.
     */
    streamClass?: new (source: AsyncGenerator<TEvent, void, void>, controller: AbortController, extractor?: StreamUsageExtractor<TEvent>) => TStream;
}
export declare function createSSEStream<TEvent, TStream extends UnifiedStream<TEvent>>(config: SSEStreamConfig<TEvent, TStream>): TStream;
//# sourceMappingURL=sse-stream.d.ts.map
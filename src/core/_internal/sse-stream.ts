// Shared SSE streaming scaffold for the three streaming resources
// (chat.completions, messages, responses). Owns everything that used to be
// triplicated: the AbortController-from-signal wiring, the `client.stream()`
// call with the compression default, the parseSSE / JSON.parse loop, the
// terminal-event return, the StreamInterruptedError wrapping for abrupt
// transport drops, and the `UnifiedStream` construction. Each resource only
// supplies what genuinely differs: how a parsed frame is interpreted (event
// shape, in-band error detection, terminal detection), the usage extractor,
// an optional `[DONE]`-style sentinel, and an optional UnifiedStream subclass.

import type { Core } from "../core";
import { StreamInterruptedError, UnifiedError } from "../errors";
import { parseSSE } from "./sse";
import { type StreamUsageExtractor, UnifiedStream } from "./stream";

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
  params: { compression?: boolean };
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
  interpret: (
    parsed: Record<string, unknown>,
    eventName: string | undefined,
  ) => SSEFrameYield<TEvent> | null;
  /** Per-resource usage extraction; see `StreamUsageExtractor`. */
  usage?: StreamUsageExtractor<TEvent> | undefined;
  /**
   * UnifiedStream subclass to construct (e.g. `MessageStream`). Defaults to
   * `UnifiedStream` itself.
   */
  streamClass?: new (
    source: AsyncGenerator<TEvent, void, void>,
    controller: AbortController,
    extractor?: StreamUsageExtractor<TEvent>,
  ) => TStream;
}

export function createSSEStream<TEvent, TStream extends UnifiedStream<TEvent>>(
  config: SSEStreamConfig<TEvent, TStream>,
): TStream {
  const { client, path, params, doneSentinel, interpret } = config;
  const controller = new AbortController();
  if (config.signal) {
    if (config.signal.aborted) controller.abort();
    else config.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  const iter = (async function* (): AsyncGenerator<TEvent, void, void> {
    // Outside the try: an HTTP-level failure opening the stream (non-2xx,
    // connect error) is not a mid-stream interruption and must surface as-is.
    const body = await client.stream(path, {
      method: "POST",
      body: { ...params, compression: params.compression ?? client.defaultCompression },
      signal: controller.signal,
    });
    try {
      for await (const msg of parseSSE(body)) {
        if (doneSentinel !== undefined && msg.data === doneSentinel) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(msg.data);
        } catch {
          continue;
        }
        const frame = interpret(parsed as Record<string, unknown>, msg.event);
        if (!frame) continue;
        yield frame.event;
        if (frame.terminal) return;
      }
    } catch (err) {
      // A caller-initiated abort surfaces here as the fetch's AbortError —
      // leave it for the consumer's cancellation path, don't relabel it.
      if (controller.signal.aborted) throw err;
      // Already-typed failures (an in-band `{error}` frame thrown by
      // `interpret`) are meaningful as-is; pass them through unchanged.
      if (err instanceof UnifiedError) throw err;
      // Anything else is an abrupt mid-stream transport drop: the socket
      // closed after a 200 but before the stream terminated (e.g. ECONNRESET
      // from an idle timeout or a provider closing a buffered generation).
      // Surface it as a typed, actionable error so callers — and
      // `sdk.agent.run`'s `errorCode` — can offer "retry / switch model"
      // instead of an opaque socket-closed string.
      throw new StreamInterruptedError(err);
    }
  })();
  const StreamClass = (config.streamClass ?? UnifiedStream) as new (
    source: AsyncGenerator<TEvent, void, void>,
    controller: AbortController,
    extractor?: StreamUsageExtractor<TEvent>,
  ) => TStream;
  return new StreamClass(iter, controller, config.usage);
}

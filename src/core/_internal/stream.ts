// AsyncIterable wrapper that owns its AbortController so callers can
// `.abort()` without constructing one. Aborting closes the iterator and
// the underlying fetch in one shot.

// Per-call usage stats, populated from the terminal SSE event of a stream
// (e.g. `response.completed` for responses, the final chunk-with-usage for
// chat.completions, `message_delta` for messages). Available on the stream
// instance once iteration drains; readers needing it mid-iteration can inspect
// the event payload directly.
export interface StreamUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  elapsed_ms: number;
  tokens_per_second: number;
}

export type StreamUsageExtractor<T> = (
  event: T,
) => Pick<StreamUsage, "input_tokens" | "output_tokens" | "total_tokens"> | null | undefined;

export class UnifiedStream<T> implements AsyncIterable<T> {
  private aborted = false;
  private readonly startedAt = Date.now();

  // Populated after the first event whose extractor returns usage. Stays null
  // if the stream never yields a terminal usage event (e.g. early abort).
  usage: StreamUsage | null = null;

  constructor(
    private readonly source: AsyncGenerator<T, void, void>,
    private readonly controller: AbortController,
    private readonly extractor?: StreamUsageExtractor<T>,
  ) {}

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.controller.abort();
    // Best-effort: tell the generator to clean up. If a `next()` is in flight,
    // the queued return() can reject with the same AbortError that's already
    // surfacing via the iterator; swallow it so it doesn't become an unhandled
    // promise rejection.
    this.source.return().catch(() => {});
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, void> {
    for await (const ev of this.source) {
      if (this.extractor && !this.usage) {
        const raw = this.extractor(ev);
        if (raw) {
          const elapsed = Date.now() - this.startedAt;
          this.usage = {
            input_tokens: raw.input_tokens,
            output_tokens: raw.output_tokens,
            total_tokens: raw.total_tokens,
            elapsed_ms: elapsed,
            tokens_per_second: elapsed > 0 ? Math.round((raw.output_tokens * 1000) / elapsed) : 0,
          };
        }
      }
      yield ev;
    }
  }
}

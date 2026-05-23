// AsyncIterable wrapper that owns its AbortController so callers can
// `.abort()` without constructing one. Aborting closes the iterator and
// the underlying fetch in one shot.

export class UnifiedStream<T> implements AsyncIterable<T> {
  private aborted = false;

  constructor(
    private readonly iter: AsyncGenerator<T, void, void>,
    private readonly controller: AbortController,
  ) {}

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.controller.abort();
    // Best-effort: tell the generator to clean up. If a `next()` is in flight,
    // the queued return() can reject with the same AbortError that's already
    // surfacing via the iterator; swallow it so it doesn't become an unhandled
    // promise rejection.
    this.iter.return().catch(() => {});
  }

  [Symbol.asyncIterator](): AsyncGenerator<T, void, void> {
    return this.iter;
  }
}

// Shared abortable sleep + generic poll loop used by resources that wait on
// server-side jobs (videos.waitUntilReady, actions.awaitResult) and by retry
// backoff (chunked uploads). Browser-safe: no node imports, no .unref().

function defaultAbortError(): Error {
  // DOMException with name "AbortError" matches what fetch throws on aborted
  // signals, so callers can use the same catch shape.
  const err = new Error("Aborted");
  err.name = "AbortError";
  return err;
}

/**
 * Abortable sleep. Resolves after `ms`; rejects with `abortError()` (default:
 * an `AbortError`-named Error) if `signal` aborts first — including when the
 * signal is already aborted on entry.
 */
export function sleep(ms: number, signal?: AbortSignal, abortError?: () => Error): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject((abortError ?? defaultAbortError)());
      return;
    }
    if (ms <= 0) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject((abortError ?? defaultAbortError)());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface PollUntilOptions<T> {
  /** Hard cap on the whole poll, in ms. See `onTimeout` for what happens then. */
  timeoutMs: number;
  /** Delay between polls, in ms. */
  intervalMs: number;
  /** Aborts the wait between polls (checked at loop top and during sleep). */
  signal?: AbortSignal;
  /** Issue one poll. Errors propagate to the caller unchanged. */
  poll: () => Promise<T>;
  /** Terminal-state test; a `true` result resolves the poll with that value. */
  isDone: (value: T) => boolean;
  /**
   * Invoked when the deadline passes. Either return a value to resolve with
   * (e.g. the last pending result) or throw a timeout error. `last` is
   * `undefined` only when the deadline check ran before the first poll
   * (possible only with `eagerDeadline`).
   */
  onTimeout: (last: T | undefined) => T;
  /**
   * When true: check the deadline BEFORE each poll (so no request is issued
   * past the caller's deadline, and `remaining <= 0` after a result also
   * times out) and cap each sleep at the remaining budget.
   * When false (default): always poll at least once; the deadline is checked
   * only after each result, with strict `elapsed > timeoutMs` semantics.
   */
  eagerDeadline?: boolean;
  /** Error thrown when `signal` aborts. Also used for aborts during sleep. */
  abortError?: () => Error;
}

/**
 * Generic poll-until-done loop. Timeout behavior is caller-defined via
 * `onTimeout` / `eagerDeadline` so resources with different contracts
 * (throw vs. return-last-result) share one loop.
 */
export async function pollUntil<T>(opts: PollUntilOptions<T>): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  let last: T | undefined;
  for (;;) {
    if (opts.signal?.aborted) throw (opts.abortError ?? defaultAbortError)();
    if (opts.eagerDeadline && Date.now() >= deadline) return opts.onTimeout(last);
    last = await opts.poll();
    if (opts.isDone(last)) return last;
    const remaining = deadline - Date.now();
    if (opts.eagerDeadline ? remaining <= 0 : remaining < 0) return opts.onTimeout(last);
    await sleep(
      opts.eagerDeadline ? Math.min(opts.intervalMs, remaining) : opts.intervalMs,
      opts.signal,
      opts.abortError,
    );
  }
}

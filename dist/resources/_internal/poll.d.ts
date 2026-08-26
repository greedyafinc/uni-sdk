/**
 * Abortable sleep. Resolves after `ms`; rejects with `abortError()` (default:
 * an `AbortError`-named Error) if `signal` aborts first — including when the
 * signal is already aborted on entry.
 */
export declare function sleep(ms: number, signal?: AbortSignal, abortError?: () => Error): Promise<void>;
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
export declare function pollUntil<T>(opts: PollUntilOptions<T>): Promise<T>;
//# sourceMappingURL=poll.d.ts.map
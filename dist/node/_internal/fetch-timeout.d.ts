/**
 * Coerce a caller-supplied timeout defensively: 0, NaN, and negative values
 * all degenerate to `setTimeout(_, 0)` (or 1ms), aborting the request before
 * it can send. A caller passing env-var-derived `Number(process.env.X)` for
 * an unset var would otherwise silently skip every request. Only finite
 * positive numbers are honored; anything else falls back to `fallbackMs`.
 */
export declare function coerceTimeoutMs(requested: number | undefined, fallbackMs: number): number;
/**
 * Run `fn` with an AbortSignal that fires after `timeoutMs` (or when
 * `outerSignal` aborts, propagating its reason). The whole callback — fetch
 * AND body read — stays under one deadline, so an endpoint that sends headers
 * then stalls the body still aborts. The timer is unref'd so a fire-and-forget
 * CLI isn't kept alive by the deadline alone. Errors from `fn` (including the
 * AbortError on deadline) propagate unchanged — callers own the mapping.
 */
export declare function withTimeoutSignal<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>, outerSignal?: AbortSignal): Promise<T>;
//# sourceMappingURL=fetch-timeout.d.ts.map
// Shared deadline plumbing for node-side loopback/OAuth fetches (revoke,
// handoff, ecosystem discovery probes). Node-only — never import from a
// browser bundle (relies on timer.unref()).

/**
 * Coerce a caller-supplied timeout defensively: 0, NaN, and negative values
 * all degenerate to `setTimeout(_, 0)` (or 1ms), aborting the request before
 * it can send. A caller passing env-var-derived `Number(process.env.X)` for
 * an unset var would otherwise silently skip every request. Only finite
 * positive numbers are honored; anything else falls back to `fallbackMs`.
 */
export function coerceTimeoutMs(requested: number | undefined, fallbackMs: number): number {
  return typeof requested === "number" && Number.isFinite(requested) && requested > 0
    ? requested
    : fallbackMs;
}

/**
 * Run `fn` with an AbortSignal that fires after `timeoutMs` (or when
 * `outerSignal` aborts, propagating its reason). The whole callback — fetch
 * AND body read — stays under one deadline, so an endpoint that sends headers
 * then stalls the body still aborts. The timer is unref'd so a fire-and-forget
 * CLI isn't kept alive by the deadline alone. Errors from `fn` (including the
 * AbortError on deadline) propagate unchanged — callers own the mapping.
 */
export async function withTimeoutSignal<T>(
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
  outerSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  const onOuterAbort = () => controller.abort(outerSignal?.reason);
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort(outerSignal.reason);
    else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
  }
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", onOuterAbort);
  }
}

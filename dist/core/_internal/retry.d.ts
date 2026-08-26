export interface RetryConfig {
    /** Max number of *retry* attempts (after the initial try). Default 3. */
    maxRetries: number;
    /** Hard ceiling on total elapsed time across all attempts (ms). Default 60_000. */
    maxElapsedMs: number;
    /** Base for exponential backoff (ms). Default 500. */
    initialDelayMs: number;
    /** Upper bound per-attempt delay (ms). Default 10_000. */
    maxDelayMs: number;
}
export declare const DEFAULT_RETRY: RetryConfig;
export interface RetryAttempt {
    /** 1-based attempt index that just *failed* and is about to be retried. */
    attempt: number;
    /** Computed wait before the next attempt (ms). */
    delayMs: number;
    /** HTTP status of the failed response, or undefined for network errors. */
    status: number | undefined;
    /** Either the failed Response or the thrown Error. */
    reason: Response | Error;
}
export type RetryListener = (event: RetryAttempt) => void;
export declare function resolveRetryConfig(override: false | Partial<RetryConfig> | undefined): RetryConfig | undefined;
export declare function isIdempotent(method: string, explicit: boolean | undefined): boolean;
/**
 * Decide if a *response* status is retry-ELIGIBLE, ignoring idempotency.
 *   - 429: yes (rate limited; honor Retry-After)
 *   - 5xx: yes (server-side transient)
 *   - everything else: no
 * 408 (Request Timeout) is also eligible — some upstream gateways emit it
 * for slow-LLM calls and a single retry usually clears it.
 *
 * Eligible is not the same as retried: client.ts additionally gates 408/5xx
 * on `isIdempotent()`, and handles 429 on its own path. See the module header.
 */
export declare function isRetryableStatus(status: number): boolean;
/**
 * Parse a raw Retry-After header value (seconds or HTTP-date). Returns ms or
 * undefined. Single source of truth for Retry-After parsing — the retry loop
 * consumes it via `parseRetryAfterHeader`, and `RateLimitError.retryAfter`
 * (errors.ts) derives its public seconds value from it.
 */
export declare function parseRetryAfterValue(v: string | null | undefined): number | undefined;
/**
 * Parse Retry-After (seconds or HTTP-date) from a Response. Returns ms or
 * undefined.
 */
export declare function parseRetryAfterHeader(res: Response): number | undefined;
/**
 * Exponential backoff with full jitter: pick a random value in `[0, cap]`
 * where `cap = min(maxDelayMs, initialDelayMs * 2^attempt)`. Attempt is
 * 0-based for the *first* retry, so attempt=0 → up to initialDelayMs, etc.
 */
export declare function computeBackoff(attempt: number, cfg: RetryConfig, rng?: () => number): number;
/**
 * Pick the wait duration before the next attempt: prefer Retry-After if the
 * server sent one and it fits inside the per-attempt cap, otherwise back off.
 */
export declare function nextDelay(attempt: number, cfg: RetryConfig, reason: Response | Error, rng?: () => number): number;
/**
 * `setTimeout` that resolves early if the abort signal fires. We don't reject
 * here — the caller's send() will see the aborted signal on its next attempt
 * and surface the right error.
 */
export declare function delay(ms: number, signal?: AbortSignal): Promise<void>;
/**
 * Network errors thrown by fetch are environment-specific (TypeError in
 * browsers, FetchError in undici, AbortError when the caller cancelled).
 * We retry network failures but NOT:
 *   - AbortError: user intent, must propagate immediately
 *   - typed SDK errors (UnifiedError and every subclass): thrown
 *     intentionally by e.g. the 401-after-refresh path; not transient.
 *
 * Node-side fetch errors (undici) decorate the Error with a `code` like
 * `ECONNRESET`, `ETIMEDOUT`, `UND_ERR_SOCKET`, `EAI_AGAIN` — those are
 * exactly the connection blips retry should cover. We can't filter on
 * `.code` alone, so SDK errors identify themselves via the
 * `isUnifiedSdkError` marker set in the `UnifiedError` base constructor
 * (errors.ts). A structural property check — deliberately NOT `instanceof`
 * (fails when two bundled copies of the SDK exchange errors) and NOT a
 * name allowlist (silently misses newly added subclasses).
 */
export declare function isNetworkErrorRetryable(err: unknown): boolean;
//# sourceMappingURL=retry.d.ts.map
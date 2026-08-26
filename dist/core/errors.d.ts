export type UnifiedErrorCode = "not_implemented" | "not_bootstrapped" | "invalid_input" | "aborted" | "app_not_installed" | "handoff_unreachable" | "auth_user_cancelled" | "auth_timeout" | "auth_state_mismatch" | "auth_token_exchange_failed" | "auth_refresh_failed" | "auth_retry_still_unauthorized" | "browser_open_failed" | "keychain_unavailable" | UnifiedAIHttpErrorCode | "stream_interrupted" | "storage_unavailable" | "storage_read_only" | "storage_not_granted" | "fs_unavailable" | "fs_read_only" | "fs_not_granted" | "invalid_path" | "edit_not_found" | "edit_not_unique" | (string & {});
export declare class UnifiedError extends Error {
    /**
     * Structural marker present on every SDK-typed error. The retry classifier
     * (`_internal/retry.ts` → `isNetworkErrorRetryable`) checks this property —
     * not `instanceof`, which fails when two copies of the SDK are bundled, and
     * not an error-name allowlist, which silently misses new subclasses — to
     * keep intentional SDK errors out of the network-retry path.
     */
    readonly isUnifiedSdkError: true;
    readonly code: UnifiedErrorCode;
    readonly status: number | undefined;
    constructor(code: UnifiedErrorCode, message: string, status?: number, cause?: unknown);
}
/**
 * Construct a plain (non-HTTP) subsystem error. The subsystem error modules
 * (storage/fs/sync) re-export this behind a code type narrowed to the codes
 * that subsystem actually raises, so call sites keep tight typing while the
 * construction logic lives in one place.
 */
export declare function subsystemError(code: UnifiedErrorCode, message: string): UnifiedError;
/**
 * A streaming response ended abnormally: the connection dropped after a 200 but
 * before the stream produced its terminating event (no `[DONE]` / finish). This
 * is distinct from an HTTP error (the request had already succeeded) and from a
 * caller abort (that surfaces as the caller's own AbortError, never this). It
 * typically means the upstream provider or gateway was slow enough to hit an
 * idle timeout, or buffered a long generation and the socket was closed mid-
 * flight. Retrying, or switching to a faster model, usually clears it. The
 * original transport error (e.g. an ECONNRESET) is attached as `cause`.
 */
export declare class StreamInterruptedError extends UnifiedError {
    constructor(cause?: unknown, message?: string);
}
export type UnifiedAIAuthErrorCode = "auth_refresh_failed" | "auth_retry_still_unauthorized";
export type UnifiedAIHttpErrorCode = "bad_request" | "unauthorized" | "forbidden" | "not_found" | "model_deprecated" | "rate_limited" | "usage_limit_exceeded" | "server_error" | "request_failed";
/**
 * Base class for HTTP errors returned by the unified-api backend. All
 * status-specific subclasses (`AuthenticationError`, `RateLimitError`, etc.)
 * extend this, so consumers can catch broadly with `UnifiedAIError` or
 * narrowly via `instanceof` on a concrete subclass.
 */
export declare class UnifiedAIError extends UnifiedError {
    readonly body: unknown;
    readonly headers: Readonly<Record<string, string>> | undefined;
    readonly requestId: string | undefined;
    constructor(code: UnifiedAIHttpErrorCode | UnifiedAIAuthErrorCode, message: string, status: number, body: unknown, headers?: Readonly<Record<string, string>>, cause?: unknown);
}
export declare class BadRequestError extends UnifiedAIError {
    constructor(message: string, status: number, body: unknown, headers?: Readonly<Record<string, string>>);
}
export declare class AuthenticationError extends UnifiedAIError {
    constructor(message: string, status: number, body: unknown, headers?: Readonly<Record<string, string>>, code?: UnifiedAIHttpErrorCode | UnifiedAIAuthErrorCode, cause?: unknown);
}
/**
 * Subclass of `AuthenticationError` used when the SDK's automatic refresh
 * flow fails (refresh-token exchange errored, or a retried request still
 * returned 401). Subclassing `AuthenticationError` means user code that
 * branches on `instanceof AuthenticationError` catches both the initial
 * 401 and the refresh-failure case, and headers/requestId from the failing
 * response are surfaced for support correlation.
 */
export declare class UnifiedAIAuthError extends AuthenticationError {
    constructor(code: UnifiedAIAuthErrorCode, message: string, status?: number, body?: unknown, headers?: Readonly<Record<string, string>>, cause?: unknown);
}
/**
 * The credential was accepted but is not allowed to perform this request
 * (HTTP 403) — e.g. an app-scoped token whose scope doesn't cover the
 * endpoint, or a key disabled by policy. Distinct from
 * `AuthenticationError` (401: credential missing/invalid, where a refresh
 * may help) — a 403 is terminal for the credential: neither retrying nor
 * refreshing will clear it.
 */
export declare class ForbiddenError extends UnifiedAIError {
    constructor(message: string, status: number, body: unknown, headers?: Readonly<Record<string, string>>);
}
export declare class NotFoundError extends UnifiedAIError {
    constructor(message: string, status: number, body: unknown, headers?: Readonly<Record<string, string>>);
}
/**
 * The requested model still exists in the catalog but has been retired and
 * is no longer callable. unified-api returns HTTP 410 with a body
 * `{code: "model_deprecated"}` from any call-time endpoint (chat, messages,
 * embeddings, images, responses, …) when a deprecated model id is requested;
 * the deprecated model is also absent from `models.list()`.
 *
 * Detected via the body `code` rather than the 410 status alone, because 410
 * is also used for expired upload sessions. Retrying will not help — switch
 * to a current model (see `models.list()`).
 */
export declare class DeprecatedModelError extends UnifiedAIError {
    readonly isDeprecated: true;
    constructor(message: string, status: number, body: unknown, headers?: Readonly<Record<string, string>>);
}
/**
 * Generic rate limiting: too many requests in a window. Honor `retryAfter`
 * (seconds) to back off.
 *
 * Sibling — NOT parent — of `UsageLimitError`. A 429 from plan-quota
 * exhaustion throws `UsageLimitError`, not `RateLimitError`, so a generic
 * retry wrapper that only checks `instanceof RateLimitError` will miss
 * quota errors (which is correct: retrying won't help). Catch both
 * explicitly when you want to surface 429s uniformly. Order matters if
 * you use `else if` chains — `UsageLimitError` does NOT pass an
 * `instanceof RateLimitError` check, but check the more specific class
 * first regardless to stay future-proof.
 */
export declare class RateLimitError extends UnifiedAIError {
    readonly retryAfter: number | undefined;
    constructor(message: string, status: number, body: unknown, headers?: Readonly<Record<string, string>>);
}
/**
 * Plan usage limit exhausted for the current billing window. Unlike
 * `RateLimitError`, this won't clear by waiting a few seconds — the user
 * must upgrade or wait until `usagePeriodStart` rolls over.
 *
 * `periodCost` and `limit` are parsed from the server message when present
 * (unified-api currently surfaces them as `"Window cost: $X.XXXX / $Y.YY"`).
 * Both are undefined if the message shape changes.
 */
export declare class UsageLimitError extends UnifiedAIError {
    readonly periodCost: number | undefined;
    readonly limit: number | undefined;
    readonly resetAt: string | undefined;
    readonly isUsageLimit: true;
    constructor(message: string, status: number, body: unknown, headers?: Readonly<Record<string, string>>);
}
export declare class ServerError extends UnifiedAIError {
    constructor(message: string, status: number, body: unknown, headers?: Readonly<Record<string, string>>);
}
/**
 * Distinguish quota exhaustion from generic throttling. unified-api's
 * `apiKeyAuthPlugin` emits `{message: "Usage limit exceeded..."}` for
 * billing-window exhaustion; its in-memory rate limiter emits
 * `{error: "rate_limited"}` for transient throttling.
 *
 * Match conditions are intentionally narrow to avoid false positives:
 *   - explicit `code: "usage_limit_exceeded"`, OR
 *   - `period_cost` AND `limit` both present (the structured shape we'd
 *     prefer unified-api to migrate to), OR
 *   - `message` starting with "Usage limit exceeded" (current shape).
 *
 * NB: a single `limit` field alone is NOT enough — a future rate-limit
 * response may include `{error: "rate_limited", limit: 60}` (requests
 * per window), and that should stay a `RateLimitError`.
 */
export declare function isUsageLimitBody(body: unknown): boolean;
export declare function httpErrorCodeFromStatus(status: number): UnifiedAIHttpErrorCode;
/**
 * Build the right typed error subclass for an HTTP failure. Falls back to
 * `UnifiedAIError` for statuses without a dedicated class (generic 4xx).
 */
export declare function buildHttpError(message: string, status: number, body: unknown, headers?: Readonly<Record<string, string>>): UnifiedAIError;
export declare function headersToRecord(h: Headers): Readonly<Record<string, string>>;
//# sourceMappingURL=errors.d.ts.map
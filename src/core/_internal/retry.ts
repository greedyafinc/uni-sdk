// Retry / backoff for transient HTTP and network failures.
//
// Classifier inspects either a fetch Response (already received) or a thrown
// error (network blip / abort) and returns whether the call is worth retrying.
// Idempotency policy lives here so request paths can stay linear: GET/HEAD/
// PUT/DELETE retry on network errors by default; POST/PATCH only retry on
// network errors when the caller marks them `idempotent: true`. All methods
// retry on 429/5xx responses by default because the server already saw the
// request — retrying is safe (and 429 with Retry-After is the only sane move).

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

export const DEFAULT_RETRY: RetryConfig = Object.freeze({
  maxRetries: 3,
  maxElapsedMs: 60_000,
  initialDelayMs: 500,
  maxDelayMs: 10_000,
});

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

export function resolveRetryConfig(
  override: false | Partial<RetryConfig> | undefined,
): RetryConfig | undefined {
  if (override === false) return undefined;
  if (!override) return DEFAULT_RETRY;
  return {
    maxRetries: override.maxRetries ?? DEFAULT_RETRY.maxRetries,
    maxElapsedMs: override.maxElapsedMs ?? DEFAULT_RETRY.maxElapsedMs,
    initialDelayMs: override.initialDelayMs ?? DEFAULT_RETRY.initialDelayMs,
    maxDelayMs: override.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs,
  };
}

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);

export function isIdempotent(method: string, explicit: boolean | undefined): boolean {
  if (explicit !== undefined) return explicit;
  return IDEMPOTENT_METHODS.has(method.toUpperCase());
}

/**
 * Decide if a *response* status is worth retrying.
 *   - 429: yes (rate limited; honor Retry-After)
 *   - 5xx: yes (server-side transient)
 *   - everything else: no
 * 408 (Request Timeout) is also retried — some upstream gateways emit it
 * for slow-LLM calls and a single retry usually clears it.
 */
export function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

/**
 * Parse Retry-After (seconds or HTTP-date). Returns ms or undefined.
 */
export function parseRetryAfterHeader(res: Response): number | undefined {
  const v = res.headers.get("retry-after");
  if (!v) return undefined;
  const trimmed = v.trim();
  // Empty / whitespace-only Retry-After: treat as missing, not as 0ms.
  // `Number("")` is 0 and isFinite, so without this guard a header of
  // "   " would degrade to a no-backoff tight retry against a misbehaving
  // server.
  if (trimmed === "") return undefined;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const t = Date.parse(trimmed);
  if (!Number.isNaN(t)) return Math.max(0, t - Date.now());
  return undefined;
}

/**
 * Exponential backoff with full jitter: pick a random value in `[0, cap]`
 * where `cap = min(maxDelayMs, initialDelayMs * 2^attempt)`. Attempt is
 * 0-based for the *first* retry, so attempt=0 → up to initialDelayMs, etc.
 */
export function computeBackoff(
  attempt: number,
  cfg: RetryConfig,
  rng: () => number = Math.random,
): number {
  const expo = cfg.initialDelayMs * 2 ** attempt;
  const cap = Math.min(cfg.maxDelayMs, expo);
  return Math.floor(rng() * cap);
}

/**
 * Pick the wait duration before the next attempt: prefer Retry-After if the
 * server sent one and it fits inside the per-attempt cap, otherwise back off.
 */
export function nextDelay(
  attempt: number,
  cfg: RetryConfig,
  reason: Response | Error,
  rng: () => number = Math.random,
): number {
  if (reason instanceof Response) {
    const retryAfter = parseRetryAfterHeader(reason);
    if (retryAfter !== undefined) {
      // Respect the server's value but never wait longer than the configured
      // ceiling — a bogus "Retry-After: 86400" must not park the request for
      // a day.
      return Math.min(retryAfter, cfg.maxDelayMs);
    }
  }
  return computeBackoff(attempt, cfg, rng);
}

/**
 * `setTimeout` that resolves early if the abort signal fires. We don't reject
 * here — the caller's send() will see the aborted signal on its next attempt
 * and surface the right error.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let onAbort: (() => void) | undefined;
    const t = setTimeout(() => {
      // Detach the abort listener so a long-lived signal reused across
      // many requests doesn't accumulate dead listeners (V8 warns past 10).
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Network errors thrown by fetch are environment-specific (TypeError in
 * browsers, FetchError in undici, AbortError when the caller cancelled).
 * We retry network failures but NOT:
 *   - AbortError: user intent, must propagate immediately
 *   - typed SDK errors (UnifiedError / UnifiedAIError / UnifiedAIAuthError):
 *     thrown intentionally by the 401-after-refresh path; not transient.
 *
 * Node-side fetch errors (undici) decorate the Error with a `code` like
 * `ECONNRESET`, `ETIMEDOUT`, `UND_ERR_SOCKET`, `EAI_AGAIN` — those are
 * exactly the connection blips retry should cover. We can't filter on
 * `.code` alone, so we structural-check against the SDK error name to
 * exclude only our own typed errors.
 */
const SDK_ERROR_NAMES = new Set([
  "UnifiedError",
  "UnifiedAIError",
  "UnifiedAIAuthError",
  "AuthenticationError",
  "BadRequestError",
  "NotFoundError",
  "DeprecatedModelError",
  "RateLimitError",
  "UsageLimitError",
  "ServerError",
]);

export function isNetworkErrorRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError") return false;
  if (SDK_ERROR_NAMES.has(err.name)) return false;
  return true;
}

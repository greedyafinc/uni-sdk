export type UnifiedErrorCode =
  | "not_implemented"
  | "not_bootstrapped"
  | "app_not_installed"
  | "handoff_unreachable"
  | "auth_user_cancelled"
  | "auth_state_mismatch"
  | "auth_token_exchange_failed"
  | "auth_refresh_failed"
  | "auth_retry_still_unauthorized"
  | "keychain_unavailable"
  | (string & {});

export class UnifiedError extends Error {
  readonly code: UnifiedErrorCode;
  readonly status: number | undefined;

  constructor(code: UnifiedErrorCode, message: string, status?: number) {
    super(message);
    this.name = "UnifiedError";
    this.code = code;
    this.status = status;
  }
}

export type UnifiedAIAuthErrorCode = "auth_refresh_failed" | "auth_retry_still_unauthorized";

export class UnifiedAIAuthError extends UnifiedError {
  readonly body: unknown;

  constructor(code: UnifiedAIAuthErrorCode, message: string, status?: number, body?: unknown) {
    super(code, message, status);
    this.name = "UnifiedAIAuthError";
    this.body = body;
  }
}

export type UnifiedAIHttpErrorCode =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "usage_limit_exceeded"
  | "server_error"
  | "request_failed";

/**
 * Base class for HTTP errors returned by the unified-api backend. All
 * status-specific subclasses (`AuthenticationError`, `RateLimitError`, etc.)
 * extend this, so consumers can catch broadly with `UnifiedAIError` or
 * narrowly via `instanceof` on a concrete subclass.
 */
export class UnifiedAIError extends UnifiedError {
  readonly body: unknown;
  readonly headers: Readonly<Record<string, string>> | undefined;
  readonly requestId: string | undefined;

  constructor(
    code: UnifiedAIHttpErrorCode,
    message: string,
    status: number,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
  ) {
    super(code, message, status);
    this.name = "UnifiedAIError";
    this.body = body;
    this.headers = headers;
    this.requestId = headers?.["x-request-id"] ?? headers?.["request-id"];
  }
}

export class BadRequestError extends UnifiedAIError {
  constructor(
    message: string,
    status: number,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
  ) {
    super("bad_request", message, status, body, headers);
    this.name = "BadRequestError";
  }
}

export class AuthenticationError extends UnifiedAIError {
  constructor(
    message: string,
    status: number,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
  ) {
    super("unauthorized", message, status, body, headers);
    this.name = "AuthenticationError";
  }
}

export class NotFoundError extends UnifiedAIError {
  constructor(
    message: string,
    status: number,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
  ) {
    super("not_found", message, status, body, headers);
    this.name = "NotFoundError";
  }
}

function parseRetryAfter(
  headers: Readonly<Record<string, string>> | undefined,
): number | undefined {
  const v = headers?.["retry-after"];
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n);
  // HTTP-date form: convert to seconds-from-now.
  const t = Date.parse(v);
  if (!Number.isNaN(t)) return Math.max(0, Math.ceil((t - Date.now()) / 1000));
  return undefined;
}

/**
 * Generic rate limiting: too many requests in a window. Distinct from
 * `UsageLimitError`, which signals quota exhaustion for the billing period.
 * Honor `retryAfter` (seconds) to back off.
 */
export class RateLimitError extends UnifiedAIError {
  readonly retryAfter: number | undefined;

  constructor(
    message: string,
    status: number,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
  ) {
    super("rate_limited", message, status, body, headers);
    this.name = "RateLimitError";
    this.retryAfter = parseRetryAfter(headers);
  }
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
export class UsageLimitError extends UnifiedAIError {
  readonly periodCost: number | undefined;
  readonly limit: number | undefined;
  readonly resetAt: string | undefined;
  readonly isUsageLimit = true as const;

  constructor(
    message: string,
    status: number,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
  ) {
    super("usage_limit_exceeded", message, status, body, headers);
    this.name = "UsageLimitError";
    const parsed = parseUsageFields(body);
    this.periodCost = parsed.periodCost;
    this.limit = parsed.limit;
    this.resetAt = parsed.resetAt;
  }
}

export class ServerError extends UnifiedAIError {
  constructor(
    message: string,
    status: number,
    body: unknown,
    headers?: Readonly<Record<string, string>>,
  ) {
    super("server_error", message, status, body, headers);
    this.name = "ServerError";
  }
}

function parseUsageFields(body: unknown): {
  periodCost: number | undefined;
  limit: number | undefined;
  resetAt: string | undefined;
} {
  let periodCost: number | undefined;
  let limit: number | undefined;
  let resetAt: string | undefined;
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (typeof obj.period_cost === "number") periodCost = obj.period_cost;
    if (typeof obj.limit === "number") limit = obj.limit;
    if (typeof obj.reset_at === "string") resetAt = obj.reset_at;
    const msg = typeof obj.message === "string" ? obj.message : undefined;
    if (msg && (periodCost === undefined || limit === undefined)) {
      const m = msg.match(/\$([0-9]+(?:\.[0-9]+)?)\s*\/\s*\$([0-9]+(?:\.[0-9]+)?)/);
      if (m) {
        if (periodCost === undefined) periodCost = Number(m[1]);
        if (limit === undefined) limit = Number(m[2]);
      }
    }
  }
  return { periodCost, limit, resetAt };
}

/**
 * Distinguish quota exhaustion from generic throttling. unified-api's
 * `apiKeyAuthPlugin` emits `{message: "Usage limit exceeded..."}` for
 * billing-window exhaustion; its in-memory rate limiter emits
 * `{error: "rate_limited"}` for transient throttling.
 */
function isUsageLimitBody(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const obj = body as Record<string, unknown>;
  if (typeof obj.message === "string" && /usage limit/i.test(obj.message)) return true;
  if (obj.code === "usage_limit_exceeded") return true;
  if (typeof obj.period_cost === "number" || typeof obj.limit === "number") return true;
  return false;
}

export function httpErrorCodeFromStatus(status: number): UnifiedAIHttpErrorCode {
  if (status === 400) return "bad_request";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server_error";
  return "request_failed";
}

/**
 * Build the right typed error subclass for an HTTP failure. Falls back to
 * `UnifiedAIError` for statuses without a dedicated class (403, generic 4xx).
 */
export function buildHttpError(
  message: string,
  status: number,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): UnifiedAIError {
  if (status === 400) return new BadRequestError(message, status, body, headers);
  if (status === 401) return new AuthenticationError(message, status, body, headers);
  if (status === 404) return new NotFoundError(message, status, body, headers);
  if (status === 429) {
    return isUsageLimitBody(body)
      ? new UsageLimitError(message, status, body, headers)
      : new RateLimitError(message, status, body, headers);
  }
  if (status >= 500) return new ServerError(message, status, body, headers);
  return new UnifiedAIError(httpErrorCodeFromStatus(status), message, status, body, headers);
}

export function headersToRecord(h: Headers): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return Object.freeze(out);
}

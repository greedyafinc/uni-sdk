# Changelog

## 0.2.0

### Added

- Typed HTTP error hierarchy (UNI-84). Every resource (`chat`, `messages`,
  `responses`, `embeddings`, `images`, `models`, `usage`) now throws a
  status-specific subclass of `UnifiedAIError`:
  - `BadRequestError` (400)
  - `AuthenticationError` (401)
  - `NotFoundError` (404)
  - `RateLimitError` (429, generic throttling — exposes `retryAfter`)
  - `UsageLimitError` (429, plan quota exhausted — exposes `periodCost`,
    `limit`, `resetAt`, `isUsageLimit: true`)
  - `ServerError` (5xx)
- `UnifiedAIError` base now carries `headers` and `requestId` (read from
  `x-request-id` / `request-id`).
- `buildHttpError(message, status, body, headers?)` factory exported for
  consumers building custom transports on top of `Core`.

### Changed

- **Breaking-ish — `err.code` values changed for 400 and 429.** Previously
  any non-`{401,403,404,5xx}` failure surfaced as `code: "request_failed"`.
  Now: 400 → `"bad_request"`, 429 throttling → `"rate_limited"`, 429 quota
  exhausted → `"usage_limit_exceeded"`. Consumers branching on
  `err.code === "request_failed"` for those statuses must update. Prefer
  `instanceof` against the new subclasses going forward.
- **Breaking-ish — `UnifiedAIHttpErrorCode` union widened.** Added members
  `"bad_request"`, `"rate_limited"`, `"usage_limit_exceeded"`. Exhaustive
  `switch (err.code)` statements typed against this union will now fail
  to compile until the new cases are added.
- **`UnifiedAIAuthError` now extends `AuthenticationError`** (which extends
  `UnifiedAIError`). Existing `instanceof UnifiedAIAuthError` and
  `instanceof UnifiedError` checks keep working, and 401 refresh-failure
  errors now surface response headers and `requestId`. Previously
  `UnifiedAIAuthError` extended `UnifiedError` directly and dropped both.
- Consumers checking `error.message` strings for 401/429/etc. should
  switch to `instanceof`. All thrown values still subclass `Error`, so
  generic catch-all handlers keep working.

### Notes

- `RateLimitError` and `UsageLimitError` are **siblings**, not
  parent/child. A generic retry wrapper that only catches `RateLimitError`
  will *not* intercept `UsageLimitError` — which is the intended design,
  since retrying a quota-exhausted request will keep failing. Code that
  wants to log all 429s uniformly should catch both explicitly.

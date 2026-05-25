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

- **Breaking-ish:** consumers that were checking error.message strings for
  401/429/etc. should switch to `instanceof` against the new classes. The
  thrown values still subclass `Error` and `UnifiedAIError`, so generic
  `catch` handlers keep working.

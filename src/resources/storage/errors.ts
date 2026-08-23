import { UnifiedError, subsystemError } from "../../core/errors";

/**
 * Error codes raised by the storage subsystem. `conflict` (optimistic-write
 * race) and `quota_exceeded` are reserved for later phases — Phase 1 is
 * single-writer and has no quota policy, so they are not emitted yet.
 */
export type StorageErrorCode =
  | "storage_unavailable"
  | "storage_read_only"
  | "storage_not_granted"
  | "not_found"
  | "invalid_input"
  // The caller's `signal` fired — before, during, or between requests.
  | "aborted";

/** Construct a typed storage error (a plain `UnifiedError`, not an HTTP error). */
export const storageError: (code: StorageErrorCode, message: string) => UnifiedError =
  subsystemError;

/** Construct the `UnifiedError` raised when a caller's `signal` aborts a storage call. */
export function storageAbortError(what: string, reason?: unknown): UnifiedError {
  return new UnifiedError("aborted", `${what} was aborted`, undefined, reason);
}

/**
 * Throw a `storageAbortError` if `signal` has already fired. Used both as a
 * pre-check (before issuing a request) and inside a catch block (to prefer
 * the abort reason over whatever error the aborted network call surfaced).
 */
export function throwIfAborted(
  signal: AbortSignal | undefined,
  what: string,
  cause?: unknown,
): void {
  if (!signal?.aborted) return;
  throw storageAbortError(what, signal.reason ?? cause);
}

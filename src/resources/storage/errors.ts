import { type UnifiedError, subsystemError } from "../../core/errors";

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
  | "invalid_input";

/** Construct a typed storage error (a plain `UnifiedError`, not an HTTP error). */
export const storageError: (code: StorageErrorCode, message: string) => UnifiedError =
  subsystemError;

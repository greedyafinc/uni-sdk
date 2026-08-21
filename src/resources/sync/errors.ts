import { type UnifiedError, subsystemError } from "../../core/errors";

/**
 * Client-side error codes raised by the sync engine before a request goes out
 * (e.g. a malformed `apply()` batch). Server-side failures surface through the
 * SDK's existing HTTP error hierarchy (`UnifiedAIError` & subclasses) — the
 * engine does NOT invent new error classes for those; see {@link isEpochMismatch}.
 */
export type SyncErrorCode = "invalid_input";

/** Construct a typed sync error (a plain `UnifiedError`, not an HTTP error). */
export const syncError: (code: SyncErrorCode, message: string) => UnifiedError = subsystemError;

/**
 * True when `err` is the server's `409 cursor_epoch_mismatch` — the signal that
 * the workspace's change log was rewound/reset and the caller must DISCARD all
 * local state and re-bootstrap. Keyed off the body `code` (surfaced on the
 * SDK's `UnifiedAIError.body`) plus the 409 status, so an unrelated 409 does
 * not trip the reset. Not a new error type — a predicate over the existing one.
 */
export function isEpochMismatch(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { status?: number; body?: unknown };
  if (e.status !== 409) return false;
  const body = e.body;
  return (
    !!body &&
    typeof body === "object" &&
    (body as { code?: unknown }).code === "cursor_epoch_mismatch"
  );
}

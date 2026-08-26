import { type UnifiedError } from "../../core/errors.js";
/**
 * Client-side error codes raised by the sync engine before a request goes out
 * (e.g. a malformed `apply()` batch). Server-side failures surface through the
 * SDK's existing HTTP error hierarchy (`UnifiedAIError` & subclasses) — the
 * engine does NOT invent new error classes for those; see {@link isEpochMismatch}.
 */
export type SyncErrorCode = "invalid_input";
/** Construct a typed sync error (a plain `UnifiedError`, not an HTTP error). */
export declare const syncError: (code: SyncErrorCode, message: string) => UnifiedError;
/**
 * True when `err` is the server's `409 cursor_epoch_mismatch` — the signal that
 * the workspace's change log was rewound/reset and the caller must DISCARD all
 * local state and re-bootstrap. Keyed off the body `code` (surfaced on the
 * SDK's `UnifiedAIError.body`) plus the 409 status, so an unrelated 409 does
 * not trip the reset. Not a new error type — a predicate over the existing one.
 */
export declare function isEpochMismatch(err: unknown): boolean;
//# sourceMappingURL=errors.d.ts.map
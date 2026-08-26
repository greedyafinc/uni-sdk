import { type UnifiedError } from "../../core/errors.js";
/**
 * Error codes raised by the fs subsystem. `quota_exceeded` is reserved for a
 * later phase (Phase 1 has no quota policy). `fs_not_granted` is reserved for
 * the host boundary, where a cross-app or ungranted access is refused.
 */
export type FsErrorCode = "fs_unavailable" | "fs_read_only" | "fs_not_granted" | "not_found" | "invalid_path" | "edit_not_found" | "edit_not_unique" | "invalid_input";
/** Construct a typed fs error (a plain `UnifiedError`, not an HTTP error). */
export declare const fsError: (code: FsErrorCode, message: string) => UnifiedError;
//# sourceMappingURL=errors.d.ts.map
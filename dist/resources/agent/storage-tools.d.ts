import type { Namespace } from "../storage/types.js";
import type { ToolSpec } from "./types.js";
export interface StorageToolsOptions {
    /**
     * Collection names the model may touch. Omit to allow any name (the
     * namespace grant still applies). Planner (and any other app) passes its
     * own collection list — the SDK never hard-codes them.
     */
    collections?: readonly string[];
    /** When false (default), omit `storage_put` / `storage_delete`. */
    write?: boolean;
}
/**
 * Build storage tools bound to `ns` (typically `sdk.storage.namespace()` or
 * `sdk.storage.namespace("other-app")` after a grant). Records are opaque
 * JSON objects — the producing app owns the schema.
 */
export declare function storageTools(ns: Namespace, opts?: StorageToolsOptions): ToolSpec[];
//# sourceMappingURL=storage-tools.d.ts.map
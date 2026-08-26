import type { WorkspaceSync } from "../sync.js";
import type { ToolSpec } from "./types.js";
export interface SyncToolsOptions {
    /** Collection names the model may touch. Omit to allow any name in `ns`. */
    collections?: readonly string[];
    /** When false (default), omit `sync_apply`. */
    write?: boolean;
}
/**
 * Build sync tools bound to one `(workspace, ns)`. Records are opaque
 * metadata bags — the producing app owns the schema.
 */
export declare function syncTools(ws: WorkspaceSync, ns: string, opts?: SyncToolsOptions): ToolSpec[];
//# sourceMappingURL=sync-tools.d.ts.map
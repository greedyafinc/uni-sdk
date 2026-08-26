import type { FsNamespace } from "../fs/types.js";
import type { ToolSpec } from "./types.js";
/**
 * Build the four file tools bound to `ns` (typically `sdk.fs.namespace()` — the
 * app's own jailed workspace). The model's file operations land in that
 * namespace and nowhere else.
 */
export declare function fsTools(ns: FsNamespace): ToolSpec[];
//# sourceMappingURL=fs-tools.d.ts.map
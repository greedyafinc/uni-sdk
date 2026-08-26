import type { Core } from "../../core/core.js";
import type { Namespace, NamespaceOptions } from "./types.js";
/**
 * Local-first, app-namespaced storage. Reached as `sdk.storage`.
 *
 * `namespace()` opens the calling app's own (read-write) namespace; the
 * namespace id is derived from the client's `appId` (host-stamped per app).
 * `namespace("other-app", { mode: "read" })` opens another app's data — in the
 * host this is gated by a user-granted capability and enforced at the trusted
 * boundary, not here.
 */
export declare class Storage {
    private readonly client;
    private readonly resolver;
    constructor(client: Core);
    /** Whether a usable storage backend exists in the current runtime. */
    available(): boolean;
    /** Open a namespace handle (defaults to the calling app's own namespace). */
    namespace(appId?: string, opts?: NamespaceOptions): Namespace;
}
//# sourceMappingURL=storage.d.ts.map
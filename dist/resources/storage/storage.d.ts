import type { Core } from "../../core/core.js";
import { NamespaceSharing } from "../_kv/grants.js";
import type { Namespace, NamespaceOptions } from "./types.js";
/**
 * App-namespaced storage. Reached as `sdk.storage`.
 *
 * `namespace()` opens the calling app's own (read-write) namespace; the
 * namespace id is derived from the client's `appId` (host-stamped per app).
 * `namespace("other-app")` opens another app's data and requires a grant
 * (`sdk.storage.grants.grant`). Local backends enforce grants here;
 * cloud backends let unified-api enforce and map `storage_not_granted`.
 */
export declare class Storage {
    #private;
    private readonly client;
    private readonly resolver;
    constructor(client: Core);
    /** Whether a usable storage backend exists in the current runtime. */
    available(): boolean;
    /**
     * Grant CRUD for this app's storage namespace. Any marketplace app can
     * expose its collections to other apps or authenticated agents without
     * baking domain types into the SDK.
     */
    get grants(): NamespaceSharing;
    /** Open a namespace handle (defaults to the calling app's own namespace). */
    namespace(appId?: string, opts?: NamespaceOptions): Namespace;
    private localGrantStore;
}
//# sourceMappingURL=storage.d.ts.map
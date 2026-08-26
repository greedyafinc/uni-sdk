import type { Core } from "../../core/core.js";
import type { FsNamespace, FsNamespaceOptions } from "./types.js";
/**
 * Local-first, app-namespaced file workspace. Reached as `sdk.fs`.
 *
 * `namespace()` opens the calling app's own (read-write) jailed tree; the id is
 * derived from the client's `appId` (host-stamped per app). `namespace("other-
 * app", { mode: "read" })` names another app's tree — a future broker will gate
 * cross-app access with a user-granted capability at the trusted boundary; today
 * the `ns` is cooperative and the read-only `mode` is enforced only here.
 */
export declare class Fs {
    private readonly client;
    private readonly resolver;
    constructor(client: Core);
    /** Whether a usable fs backend exists in the current runtime. */
    available(): boolean;
    /** Open a namespace handle (defaults to the calling app's own workspace). */
    namespace(appId?: string, opts?: FsNamespaceOptions): FsNamespace;
}
//# sourceMappingURL=fs.d.ts.map
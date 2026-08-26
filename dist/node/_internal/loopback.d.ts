import type { LoopbackServer } from "../../auth/browser-sign-in.js";
export interface NodeLoopbackOptions {
    /**
     * Hard deadline in milliseconds for the OAuth redirect to arrive after
     * `start()`. When it fires, `waitForCode` rejects with `auth_timeout` so
     * the sign-in flow's cleanup path closes the server instead of hanging
     * forever on a flow the user abandoned. Only finite positive numbers are
     * honored; anything else falls back to the default (5 minutes).
     */
    readonly timeoutMs?: number;
}
export declare function createNodeLoopback(options?: NodeLoopbackOptions): LoopbackServer;
//# sourceMappingURL=loopback.d.ts.map
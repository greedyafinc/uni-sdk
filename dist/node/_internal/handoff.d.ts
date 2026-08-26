import { type TokenSet } from "../../core/_internal/tokens.js";
export interface HandoffArgs {
    readonly port: number;
    readonly clientId: string;
    readonly fetch: typeof globalThis.fetch;
    readonly signal?: AbortSignal;
    /**
     * Hard deadline in milliseconds for the whole handoff exchange (connect,
     * response, body). This is a localhost call to the desktop app — a healthy
     * endpoint answers in milliseconds, so a short deadline turns a stalled
     * endpoint (socket accepted, response never sent) into a clean
     * `handoff_unreachable` that the bootstrap ladder falls through, instead
     * of hanging bootstrap indefinitely. Only finite positive numbers are
     * honored; anything else falls back to the default (3000ms).
     */
    readonly timeoutMs?: number;
    /**
     * Per-launch shared secret required by the desktop app's /handoff endpoint,
     * forwarded as the `x-handoff-token` header. The node client sources this
     * from its EnvReader (UNIFIEDAI_HANDOFF_TOKEN by default) so hosts/tests
     * can inject it. Absent → no header (back-compat with older desktops).
     */
    readonly handoffToken?: string;
}
export declare function requestHandoff(args: HandoffArgs): Promise<TokenSet>;
//# sourceMappingURL=handoff.d.ts.map
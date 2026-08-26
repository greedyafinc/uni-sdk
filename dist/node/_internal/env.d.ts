/**
 * Snapshot of the environment-derived configuration the node client consumes.
 * All fields beyond the original two are optional so existing injected
 * readers (tests, hosts) keep type-checking unchanged; a field left
 * `undefined` falls back to the client's built-in default.
 */
export interface Env {
    readonly handoffPort: number | undefined;
    readonly clientId: string | undefined;
    /**
     * Per-launch shared secret the desktop app injects (UNIFIEDAI_HANDOFF_TOKEN)
     * into processes it spawns; forwarded as the `x-handoff-token` header on
     * handoff requests. Absent → no header (back-compat with older desktops).
     */
    readonly handoffToken?: string | undefined;
    /** Override for the OAuth authorize page (UNIFIEDAI_AUTHORIZE_URL). */
    readonly authorizeUrl?: string | undefined;
    /** Override for the OAuth token endpoint (UNIFIEDAI_TOKEN_URL). */
    readonly tokenUrl?: string | undefined;
    /** Override for the OAuth revoke endpoint (UNIFIEDAI_REVOKE_URL). */
    readonly revokeUrl?: string | undefined;
}
export interface EnvReader {
    read(): Env;
}
export declare const defaultEnvReader: EnvReader;
//# sourceMappingURL=env.d.ts.map
export interface RevokeArgs {
    readonly revokeUrl: string;
    readonly clientId: string;
    readonly token: string;
    readonly tokenTypeHint?: "access_token" | "refresh_token";
    readonly fetch: typeof globalThis.fetch;
    /**
     * Hard deadline in milliseconds. The revoke fetch is aborted if it doesn't
     * complete in time; the function still resolves (best-effort semantics).
     * Defaults to 5000ms — long enough for any healthy endpoint, short enough
     * not to wedge a logout UI on a slow/black-holed network.
     */
    readonly timeoutMs?: number;
}
export declare function revokeToken(args: RevokeArgs): Promise<void>;
export declare function deriveRevokeUrl(tokenUrl: string): string;
//# sourceMappingURL=revoke.d.ts.map
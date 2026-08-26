import type { TokenSet } from "../../core/_internal/tokens.js";
export interface RefreshArgs {
    readonly tokenUrl: string;
    readonly clientId: string;
    readonly refreshToken: string;
    readonly fetch: typeof globalThis.fetch;
}
export declare function refreshTokens(args: RefreshArgs): Promise<TokenSet>;
//# sourceMappingURL=refresh.d.ts.map
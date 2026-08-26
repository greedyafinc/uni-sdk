export interface TokenSet {
    readonly access_token: string;
    readonly refresh_token: string;
    readonly expires_at: number;
    readonly user_id: string;
    readonly client_id: string;
}
export declare function isTokenSet(value: unknown): value is TokenSet;
//# sourceMappingURL=tokens.d.ts.map
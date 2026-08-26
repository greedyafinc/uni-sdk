import { type TokenSet } from "../../core/_internal/tokens.js";
export interface KeychainAdapter {
    get(clientId: string): Promise<TokenSet | null>;
    set(clientId: string, tokens: TokenSet): Promise<void>;
    clear(clientId: string): Promise<void>;
}
export declare function createDefaultKeychain(): KeychainAdapter;
export declare class InMemoryKeychain implements KeychainAdapter {
    private readonly store;
    get(clientId: string): Promise<TokenSet | null>;
    set(clientId: string, tokens: TokenSet): Promise<void>;
    clear(clientId: string): Promise<void>;
}
//# sourceMappingURL=keychain.d.ts.map
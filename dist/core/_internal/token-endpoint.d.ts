import type { UnifiedError } from "../errors.js";
import { type TokenSet } from "./tokens.js";
export interface PostTokenGrantArgs {
    readonly tokenUrl: string;
    readonly body: Record<string, string>;
    readonly fetch: typeof globalThis.fetch;
    readonly makeError: (message: string, status?: number) => UnifiedError;
}
export declare function postTokenGrant(args: PostTokenGrantArgs): Promise<TokenSet>;
//# sourceMappingURL=token-endpoint.d.ts.map
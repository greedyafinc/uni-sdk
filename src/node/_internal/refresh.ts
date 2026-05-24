import type { TokenSet } from "../../core/_internal/tokens";
import { UnifiedAIAuthError } from "../../core/errors";
import { postTokenGrant } from "./token-endpoint";

export interface RefreshArgs {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly refreshToken: string;
  readonly fetch: typeof globalThis.fetch;
}

export function refreshTokens(args: RefreshArgs): Promise<TokenSet> {
  return postTokenGrant({
    tokenUrl: args.tokenUrl,
    fetch: args.fetch,
    body: {
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
      client_id: args.clientId,
    },
    makeError: (msg, status) => new UnifiedAIAuthError("auth_refresh_failed", msg, status),
  });
}

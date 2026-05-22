import { UnifiedAIAuthError } from "../errors";
import { type TokenSet, isTokenSet } from "./tokens";

export interface RefreshArgs {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly refreshToken: string;
  readonly fetch: typeof globalThis.fetch;
}

export async function refreshTokens(args: RefreshArgs): Promise<TokenSet> {
  const { tokenUrl, clientId, refreshToken, fetch } = args;
  let res: Response;
  try {
    res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
  } catch {
    throw new UnifiedAIAuthError(`token endpoint ${tokenUrl} unreachable`);
  }
  if (!res.ok) {
    throw new UnifiedAIAuthError(`refresh failed with ${res.status}`, res.status);
  }
  const body = (await res.json()) as unknown;
  if (!isTokenSet(body)) {
    throw new UnifiedAIAuthError("refresh returned malformed payload");
  }
  return body;
}

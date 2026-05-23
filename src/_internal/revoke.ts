export interface RevokeArgs {
  readonly revokeUrl: string;
  readonly clientId: string;
  readonly token: string;
  readonly tokenTypeHint?: "access_token" | "refresh_token";
  readonly fetch: typeof globalThis.fetch;
}

// Best-effort RFC 7009 revoke. Never throws — the caller (signOut) must
// proceed to clear local state regardless of server reachability.
export async function revokeToken(args: RevokeArgs): Promise<void> {
  const body: Record<string, string> = {
    token: args.token,
    client_id: args.clientId,
  };
  if (args.tokenTypeHint) body.token_type_hint = args.tokenTypeHint;
  try {
    await args.fetch(args.revokeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // swallow
  }
}

export function deriveRevokeUrl(tokenUrl: string): string {
  return tokenUrl.replace(/\/oauth\/token(\b|$)/, "/oauth/revoke$1");
}

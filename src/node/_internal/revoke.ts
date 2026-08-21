import { coerceTimeoutMs, withTimeoutSignal } from "./fetch-timeout";

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

const DEFAULT_REVOKE_TIMEOUT_MS = 5000;

// Best-effort RFC 7009 revoke. Never throws and never hangs — the caller
// (signOut) must proceed to clear local state regardless of server
// reachability. A network black-hole or stalled endpoint is treated the same
// as an explicit failure: the timeout fires, the fetch is aborted, and the
// function resolves.
export async function revokeToken(args: RevokeArgs): Promise<void> {
  const body: Record<string, string> = {
    token: args.token,
    client_id: args.clientId,
  };
  if (args.tokenTypeHint) body.token_type_hint = args.tokenTypeHint;

  try {
    await withTimeoutSignal(coerceTimeoutMs(args.timeoutMs, DEFAULT_REVOKE_TIMEOUT_MS), (signal) =>
      args.fetch(args.revokeUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      }),
    );
  } catch {
    // swallow network errors, AbortError, anything else
  }
}

export function deriveRevokeUrl(tokenUrl: string): string {
  return tokenUrl.replace(/\/oauth\/token(\b|$)/, "/oauth/revoke$1");
}

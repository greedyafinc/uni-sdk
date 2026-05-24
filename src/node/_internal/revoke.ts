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

  const controller = new AbortController();
  // Coerce defensively: 0, NaN, and negative values all degenerate to
  // `setTimeout(_, 0)` (or 1ms), aborting the revoke before it can send.
  // A caller passing env-var-derived `Number(process.env.X)` for an unset
  // var would otherwise silently skip every revoke. Only finite positive
  // numbers are honored; anything else falls back to the default.
  const requested = args.timeoutMs;
  const timeoutMs =
    typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? requested
      : DEFAULT_REVOKE_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // CLIs that fire-and-forget signOut shouldn't have process exit blocked by
  // this timer; unref where supported.
  (timer as { unref?: () => void }).unref?.();
  try {
    await args.fetch(args.revokeUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch {
    // swallow network errors, AbortError, anything else
  } finally {
    clearTimeout(timer);
  }
}

export function deriveRevokeUrl(tokenUrl: string): string {
  return tokenUrl.replace(/\/oauth\/token(\b|$)/, "/oauth/revoke$1");
}

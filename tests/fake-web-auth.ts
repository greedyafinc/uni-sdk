// Stand-in for UnifiedApp Web (/oauth/authorize) + unified-api (/oauth/token).
// Authorize immediately redirects to the SDK's loopback redirect_uri with a code.

export interface FakeWebAuth {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly stop: () => Promise<void>;
  readonly refreshCallCount: () => number;
  readonly revokeRefreshTokens: () => void;
  readonly revokeUrl: string;
  readonly revokeCalls: () => ReadonlyArray<{
    token: string;
    client_id: string;
    token_type_hint?: string;
  }>;
  readonly failRevoke: (status: number) => void;
  /**
   * Make subsequent /oauth/token refresh requests block until releaseRefresh()
   * is called. Used by race tests that need to pin a refresh in flight while
   * issuing a concurrent signOut.
   */
  readonly pauseRefresh: () => void;
  /** Release any /oauth/token refresh requests blocked by pauseRefresh(). */
  readonly releaseRefresh: () => void;
  /**
   * Make the /oauth/revoke endpoint hang indefinitely. The request body is
   * still recorded in revokeCalls(). Used by tests that need to prove
   * timeout-driven abandonment of revoke completes signOut.
   */
  readonly hangRevoke: () => void;
  /**
   * Resolves when at least one refresh request has reached the /oauth/token
   * handler (i.e. the SDK has dispatched its refresh POST). Useful for
   * deterministically sequencing race-condition tests instead of relying on
   * microtask yields.
   */
  readonly waitForRefreshStarted: () => Promise<void>;
  /**
   * Resolves when at least one revoke request has reached the /oauth/revoke
   * handler. Mirrors waitForRefreshStarted — use it to synchronize tests on
   * "signOut has reached its revoke fetch", which necessarily means
   * clearLocalSession has completed.
   */
  readonly waitForRevokeRequest: () => Promise<void>;
}

export interface FakeWebAuthConfig {
  readonly userId: string;
  readonly expectedClientId: string;
}

export async function startFakeWebAuth(config: FakeWebAuthConfig): Promise<FakeWebAuth> {
  const issuedCodes = new Map<string, { verifierChallenge: string; clientId: string }>();
  const liveRefresh = new Set<string>();
  let refreshCalls = 0;
  let revokeRefresh = false;
  const revokeCallsLog: { token: string; client_id: string; token_type_hint?: string }[] = [];
  let revokeFailStatus = 0;

  // Refresh gating for race tests. When `refreshGate` is non-null the handler
  // awaits it before composing the response, letting a test pin a refresh in
  // flight while it runs concurrent work (e.g. signOut).
  let refreshGate: Promise<void> | null = null;
  let releaseRefreshGate: (() => void) | null = null;
  const refreshStartedWaiters: Array<() => void> = [];
  const revokeRequestWaiters: Array<() => void> = [];
  let revokeHang = false;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/oauth/authorize" && req.method === "GET") {
        const clientId = url.searchParams.get("client_id") ?? "";
        const redirectUri = url.searchParams.get("redirect_uri") ?? "";
        const challenge = url.searchParams.get("code_challenge") ?? "";
        const state = url.searchParams.get("state") ?? "";
        if (clientId !== config.expectedClientId) {
          return new Response("unknown client", { status: 400 });
        }
        const code = `code_${Math.random().toString(36).slice(2)}`;
        issuedCodes.set(code, { verifierChallenge: challenge, clientId });
        const target = new URL(redirectUri);
        target.searchParams.set("code", code);
        target.searchParams.set("state", state);
        return Response.redirect(target.toString(), 302);
      }

      if (url.pathname === "/oauth/token" && req.method === "POST") {
        const body = (await req.json()) as {
          grant_type?: string;
          code?: string;
          code_verifier?: string;
          client_id?: string;
          refresh_token?: string;
        };

        if (body.grant_type === "refresh_token") {
          refreshCalls += 1;
          // Notify anyone waiting for "refresh request actually hit the server".
          while (refreshStartedWaiters.length > 0) {
            const w = refreshStartedWaiters.shift();
            w?.();
          }
          // Hold the response if the test has paused refresh.
          if (refreshGate) await refreshGate;
          const rt = body.refresh_token;
          if (
            revokeRefresh ||
            !rt ||
            !liveRefresh.has(rt) ||
            body.client_id !== config.expectedClientId
          ) {
            return new Response("invalid_grant", { status: 400 });
          }
          liveRefresh.delete(rt);
          const newRefresh = `web_refresh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          liveRefresh.add(newRefresh);
          return Response.json({
            access_token: `web_access_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
            refresh_token: newRefresh,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user_id: config.userId,
            client_id: body.client_id,
          });
        }

        const code = body.code;
        const verifier = body.code_verifier;
        const issued = code ? issuedCodes.get(code) : undefined;
        if (!code || !verifier || !issued || issued.clientId !== body.client_id) {
          return new Response("invalid_grant", { status: 400 });
        }
        const expectedChallenge = await sha256base64url(verifier);
        if (expectedChallenge !== issued.verifierChallenge) {
          return new Response("invalid_grant", { status: 400 });
        }
        issuedCodes.delete(code);
        const refresh = `web_refresh_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        liveRefresh.add(refresh);
        return Response.json({
          access_token: `web_access_${Date.now()}`,
          refresh_token: refresh,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user_id: config.userId,
          client_id: issued.clientId,
        });
      }

      if (url.pathname === "/oauth/revoke" && req.method === "POST") {
        const body = (await req.json()) as {
          token?: string;
          client_id?: string;
          token_type_hint?: string;
        };
        const entry: { token: string; client_id: string; token_type_hint?: string } = {
          token: body.token ?? "",
          client_id: body.client_id ?? "",
        };
        if (body.token_type_hint !== undefined) entry.token_type_hint = body.token_type_hint;
        revokeCallsLog.push(entry);
        // Notify any test awaiting "revoke request actually hit the server".
        while (revokeRequestWaiters.length > 0) {
          const w = revokeRequestWaiters.shift();
          w?.();
        }
        if (revokeHang) {
          // Honor the client's AbortSignal so signOut can still complete via
          // timeout — but never resolve on our own. This models a black-holed
          // endpoint accurately.
          return new Promise<Response>((_resolve, reject) => {
            const onAbort = () => reject(new DOMException("aborted", "AbortError"));
            if (req.signal.aborted) onAbort();
            else req.signal.addEventListener("abort", onAbort, { once: true });
          });
        }
        if (revokeFailStatus) {
          return new Response("err", { status: revokeFailStatus });
        }
        if (body.token && body.client_id === config.expectedClientId) {
          liveRefresh.delete(body.token);
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }

      return new Response("not found", { status: 404 });
    },
  });

  const base = `http://127.0.0.1:${server.port}`;
  return {
    authorizeUrl: `${base}/oauth/authorize`,
    tokenUrl: `${base}/oauth/token`,
    stop: async () => {
      await server.stop(true);
    },
    refreshCallCount: () => refreshCalls,
    revokeRefreshTokens: () => {
      revokeRefresh = true;
    },
    revokeUrl: `${base}/oauth/revoke`,
    revokeCalls: () => revokeCallsLog,
    failRevoke: (status: number) => {
      revokeFailStatus = status;
    },
    pauseRefresh: () => {
      if (refreshGate) return; // already paused
      refreshGate = new Promise<void>((resolve) => {
        releaseRefreshGate = resolve;
      });
    },
    releaseRefresh: () => {
      const r = releaseRefreshGate;
      refreshGate = null;
      releaseRefreshGate = null;
      r?.();
    },
    waitForRefreshStarted: () =>
      new Promise<void>((resolve) => {
        refreshStartedWaiters.push(resolve);
      }),
    hangRevoke: () => {
      revokeHang = true;
    },
    waitForRevokeRequest: () =>
      new Promise<void>((resolve) => {
        revokeRequestWaiters.push(resolve);
      }),
  };
}

async function sha256base64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

// Stand-in for UnifiedApp Web (/oauth/authorize) + unified-api (/oauth/token).
// Authorize immediately redirects to the SDK's loopback redirect_uri with a code.

export interface FakeWebAuth {
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly stop: () => Promise<void>;
}

export interface FakeWebAuthConfig {
  readonly userId: string;
  readonly expectedClientId: string;
}

export async function startFakeWebAuth(config: FakeWebAuthConfig): Promise<FakeWebAuth> {
  const issuedCodes = new Map<string, { verifierChallenge: string; clientId: string }>();
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
          code?: string;
          code_verifier?: string;
          client_id?: string;
        };
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
        return Response.json({
          access_token: `web_access_${Date.now()}`,
          refresh_token: `web_refresh_${Date.now()}`,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user_id: config.userId,
          client_id: issued.clientId,
        });
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
  };
}

async function sha256base64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = new Uint8Array(digest);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

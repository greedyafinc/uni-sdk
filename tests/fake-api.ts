// Stand-in for unified-api: a simple bearer-protected endpoint that the
// transport-refresh tests hit. The set of accepted access tokens can be
// rotated to simulate token expiry, and behavior on the next call can be
// scripted (e.g. "always 401" to test the refresh-then-still-401 path).

export interface FakeApi {
  readonly baseUrl: string;
  readonly stop: () => Promise<void>;
  readonly setValidAccessTokens: (tokens: Iterable<string>) => void;
  /** When true, every request returns 401 regardless of token. */
  readonly forceAlways401: (on: boolean) => void;
  readonly requestCount: () => number;
}

export async function startFakeApi(initialTokens: string[] = []): Promise<FakeApi> {
  let valid = new Set(initialTokens);
  let always401 = false;
  let count = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      count += 1;
      const auth = req.headers.get("authorization") ?? "";
      const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      if (always401 || !valid.has(token)) {
        return new Response("unauthorized", { status: 401 });
      }
      return Response.json({ ok: true, token });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      await server.stop(true);
    },
    setValidAccessTokens: (tokens) => {
      valid = new Set(tokens);
    },
    forceAlways401: (on) => {
      always401 = on;
    },
    requestCount: () => count,
  };
}

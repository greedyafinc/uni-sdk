// Stand-in for the UnifiedApp desktop's localhost handoff server.
// Returns tokens for a single known client_id; 404s anything else.

export interface FakeDesktop {
  readonly port: number;
  readonly requestCount: () => number;
  readonly stop: () => Promise<void>;
}

export interface FakeDesktopConfig {
  readonly knownClientId: string;
  readonly userId: string;
}

export async function startFakeDesktop(config: FakeDesktopConfig): Promise<FakeDesktop> {
  let count = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/handoff" || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      count++;
      const body = (await req.json()) as { client_id?: string };
      if (body.client_id !== config.knownClientId) {
        return new Response("unknown client", { status: 404 });
      }
      return Response.json({
        access_token: `desktop_access_${Date.now()}`,
        refresh_token: `desktop_refresh_${Date.now()}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user_id: config.userId,
        client_id: body.client_id,
      });
    },
  });
  return {
    port: server.port ?? 0,
    requestCount: () => count,
    stop: async () => {
      await server.stop(true);
    },
  };
}

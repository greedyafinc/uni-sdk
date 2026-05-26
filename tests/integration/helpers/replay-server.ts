import { Buffer } from "node:buffer";
import type { Cassette, CassetteInteraction } from "./cassette";
import { loadCassette } from "./cassette";

export interface ReplayServer {
  baseUrl: string;
  /** Load a cassette and queue its interactions for the next requests. */
  use: (cassetteName: string) => void;
  /** Inspect requests that have been served from the queue. */
  requests: () => Array<{ method: string; path: string; body: unknown }>;
  stop: () => Promise<void>;
}

interface QueuedInteraction extends CassetteInteraction {
  cassette: string;
}

export async function startReplayServer(): Promise<ReplayServer> {
  let queue: QueuedInteraction[] = [];
  const served: Array<{ method: string; path: string; body: unknown }> = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const url = new URL(req.url);
      const text = await req.text();
      let body: unknown;
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      served.push({ method: req.method, path: url.pathname, body });

      const next = queue.shift();
      if (!next) {
        return new Response(
          JSON.stringify({
            error: {
              message: `No cassette interaction queued for ${req.method} ${url.pathname}`,
              type: "cassette_miss",
            },
          }),
          { status: 599, headers: { "content-type": "application/json" } },
        );
      }

      if (next.request.method !== req.method || next.request.path !== url.pathname) {
        return new Response(
          JSON.stringify({
            error: {
              message:
                `Cassette mismatch in ${next.cassette}: ` +
                `expected ${next.request.method} ${next.request.path}, ` +
                `got ${req.method} ${url.pathname}`,
              type: "cassette_mismatch",
            },
          }),
          { status: 599, headers: { "content-type": "application/json" } },
        );
      }

      const { response } = next;
      const headers = { ...response.headers };
      // Binary cassettes carry their body as base64 — decode and replay raw
      // bytes so the SDK can read them via `arrayBuffer()` without going
      // through JSON.stringify (which would corrupt non-text payloads).
      if (typeof response.bodyBase64 === "string") {
        const bytes = Uint8Array.from(Buffer.from(response.bodyBase64, "base64"));
        return new Response(bytes, { status: response.status, headers });
      }
      const payload =
        typeof response.body === "string" ? response.body : JSON.stringify(response.body);
      return new Response(payload, { status: response.status, headers });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    use(cassetteName: string) {
      const cassette: Cassette = loadCassette(cassetteName);
      for (const interaction of cassette.interactions) {
        queue.push({ ...interaction, cassette: cassetteName });
      }
    },
    requests: () => served.slice(),
    stop: async () => {
      queue = [];
      await server.stop(true);
    },
  };
}

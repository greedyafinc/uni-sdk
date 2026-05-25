import type { Cassette, CassetteInteraction } from "./cassette";
import { saveCassette } from "./cassette";

export interface Recorder {
  baseUrl: string;
  /** Begin recording into the given cassette name. Overwrites on stop(). */
  start: (cassetteName: string) => void;
  /** Flush the active cassette to disk. */
  flush: () => void;
  stop: () => Promise<void>;
}

export interface RecorderOptions {
  /** URL of the live unified-api (default http://127.0.0.1:3000). */
  upstream?: string;
}

export async function startRecorder(opts: RecorderOptions = {}): Promise<Recorder> {
  const upstream = opts.upstream ?? "http://127.0.0.1:3000";
  let activeName: string | undefined;
  let interactions: CassetteInteraction[] = [];

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const incomingUrl = new URL(req.url);
      const text = await req.text();
      let parsedBody: unknown;
      if (text) {
        try {
          parsedBody = JSON.parse(text);
        } catch {
          parsedBody = text;
        }
      }

      const targetUrl = new URL(incomingUrl.pathname + incomingUrl.search, upstream);
      const headers = new Headers(req.headers);
      headers.delete("host");

      const init: RequestInit = { method: req.method, headers };
      if (text) init.body = text;
      const upstreamRes = await fetch(targetUrl, init);

      const respHeaders: Record<string, string> = {};
      upstreamRes.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });
      const respText = await upstreamRes.text();
      const isJson = respHeaders["content-type"]?.includes("application/json") ?? false;
      const isSse = respHeaders["content-type"]?.includes("text/event-stream") ?? false;
      let respBody: unknown = respText;
      if (isJson && respText) {
        try {
          respBody = JSON.parse(respText);
        } catch {
          respBody = respText;
        }
      }

      if (activeName) {
        interactions.push({
          request: {
            method: req.method,
            path: incomingUrl.pathname,
            body: parsedBody,
          },
          response: {
            status: upstreamRes.status,
            headers: respHeaders,
            body: respBody,
            ...(isSse ? { stream: true } : {}),
          },
        });
      }

      return new Response(respText, {
        status: upstreamRes.status,
        headers: respHeaders,
      });
    },
  });

  return {
    baseUrl: `http://127.0.0.1:${server.port}`,
    start(cassetteName: string) {
      activeName = cassetteName;
      interactions = [];
    },
    flush() {
      if (!activeName) return;
      const bad = interactions.filter((i) => i.response.status >= 400);
      if (bad.length > 0) {
        const summary = bad
          .map((i) => `${i.request.method} ${i.request.path} → ${i.response.status}`)
          .join("\n  ");
        throw new Error(
          `Refusing to save cassette '${activeName}': ${bad.length} non-2xx response(s) recorded. Fix the upstream and re-record.\n  ${summary}`,
        );
      }
      const cassette: Cassette = { interactions };
      saveCassette(activeName, cassette);
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}

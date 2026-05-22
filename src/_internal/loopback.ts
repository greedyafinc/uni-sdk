import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { UnifiedError } from "../errors";
import type { LoopbackHandle, LoopbackServer } from "./browser-auth";

export function createNodeLoopback(): LoopbackServer {
  let server: Server | null = null;
  let codePromise: Promise<{ code: string; state: string }> | null = null;

  return {
    async start(): Promise<LoopbackHandle> {
      codePromise = new Promise((resolve, reject) => {
        server = createServer((req, res) => {
          const url = new URL(req.url ?? "/", "http://127.0.0.1");
          if (url.pathname !== "/callback") {
            res.writeHead(404).end();
            return;
          }
          const err = url.searchParams.get("error");
          if (err) {
            res
              .writeHead(200, { "content-type": "text/html" })
              .end("<h1>Sign-in cancelled</h1><p>You can close this window.</p>");
            reject(new UnifiedError("auth_user_cancelled", `oauth error: ${err}`));
            return;
          }
          const code = url.searchParams.get("code");
          const state = url.searchParams.get("state");
          if (!code || !state) {
            res.writeHead(400).end();
            reject(
              new UnifiedError("auth_token_exchange_failed", "callback missing code/state"),
            );
            return;
          }
          res
            .writeHead(200, { "content-type": "text/html" })
            .end("<h1>Signed in</h1><p>You can close this window.</p>");
          resolve({ code, state });
        });
      });
      await new Promise<void>((resolve, reject) => {
        if (!server) return reject(new Error("loopback server not initialised"));
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const addr = server!.address() as AddressInfo;
      const port = addr.port;
      const pending = codePromise;
      return {
        redirectUri: `http://127.0.0.1:${port}/callback`,
        async waitForCode(expectedState: string): Promise<string> {
          const { code, state } = await pending;
          if (state !== expectedState) {
            throw new UnifiedError("auth_state_mismatch", "oauth state mismatch");
          }
          return code;
        },
      };
    },
    async stop(): Promise<void> {
      if (server) {
        const s = server;
        server = null;
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
    },
  };
}

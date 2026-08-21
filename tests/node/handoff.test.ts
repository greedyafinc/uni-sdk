import { afterEach, describe, expect, test } from "bun:test";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { UnifiedError } from "../../src/core/errors";
import { requestHandoff } from "../../src/node/_internal/handoff";

// requestHandoff talks to the desktop app's loopback /handoff endpoint. The
// happy path against a well-behaved desktop is covered by the bootstrap suite
// via tests/fake-desktop.ts; these tests pin the deadline behavior — a
// desktop that accepts the socket but stalls must become a clean
// `handoff_unreachable` (the code tryHandoff treats as fall-through-able)
// instead of hanging bootstrap forever.
describe("requestHandoff", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server) {
      const s = server;
      server = null;
      // Stalled-request tests leave sockets open; force them shut so close()
      // doesn't wait on them.
      (s as { closeAllConnections?: () => void }).closeAllConnections?.();
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  async function listen(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
  ): Promise<number> {
    server = createServer(handler);
    const s = server;
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", () => resolve()));
    return (s.address() as AddressInfo).port;
  }

  test("stalled endpoint (socket accepted, no response) times out as handoff_unreachable", async () => {
    const port = await listen(() => {
      /* accept and never respond */
    });
    const err = await requestHandoff({
      port,
      clientId: "test-app",
      fetch: globalThis.fetch,
      timeoutMs: 50,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnifiedError);
    expect((err as UnifiedError).code).toBe("handoff_unreachable");
  });

  test("endpoint that sends 200 headers then stalls the body times out as handoff_unreachable", async () => {
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"access_token":');
      /* never end */
    });
    const err = await requestHandoff({
      port,
      clientId: "test-app",
      fetch: globalThis.fetch,
      timeoutMs: 50,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnifiedError);
    expect((err as UnifiedError).code).toBe("handoff_unreachable");
  });

  test("healthy endpoint returns the token set under the deadline", async () => {
    const tokens = {
      access_token: "at",
      refresh_token: "rt",
      expires_at: 1_900_000_000,
      user_id: "user-1",
      client_id: "test-app",
    };
    const port = await listen((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(tokens));
    });
    const got = await requestHandoff({
      port,
      clientId: "test-app",
      fetch: globalThis.fetch,
      timeoutMs: 1000,
    });
    expect(got.access_token).toBe("at");
    expect(got.client_id).toBe("test-app");
  });

  test("caller-supplied signal aborts a stalled call and maps to handoff_unreachable", async () => {
    const port = await listen(() => {
      /* accept and never respond */
    });
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    const err = await requestHandoff({
      port,
      clientId: "test-app",
      fetch: globalThis.fetch,
      signal: controller.signal,
      timeoutMs: 10_000,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    // The pre-aborted signal must win long before the 10s deadline.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(err).toBeInstanceOf(UnifiedError);
    expect((err as UnifiedError).code).toBe("handoff_unreachable");
  });
});

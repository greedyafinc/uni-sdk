import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { LoopbackHandle, LoopbackServer } from "../../auth/browser-sign-in";
import { UnifiedError } from "../../core/errors";

// A browser sign-in is a human-speed operation: five minutes is generous for
// typing a password + MFA, while still guaranteeing that an abandoned flow
// (tab closed, user walked away) eventually rejects so the caller's
// `finally { loopback.stop() }` runs and the listener is released.
const DEFAULT_SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

export interface NodeLoopbackOptions {
  /**
   * Hard deadline in milliseconds for the OAuth redirect to arrive after
   * `start()`. When it fires, `waitForCode` rejects with `auth_timeout` so
   * the sign-in flow's cleanup path closes the server instead of hanging
   * forever on a flow the user abandoned. Only finite positive numbers are
   * honored; anything else falls back to the default (5 minutes).
   */
  readonly timeoutMs?: number;
}

export function createNodeLoopback(options: NodeLoopbackOptions = {}): LoopbackServer {
  const requested = options.timeoutMs;
  const timeoutMs =
    typeof requested === "number" && Number.isFinite(requested) && requested > 0
      ? requested
      : DEFAULT_SIGN_IN_TIMEOUT_MS;

  let server: Server | null = null;
  let codePromise: Promise<{ code: string; state: string }> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Set by stop()/settlement so a late timer can never reject a promise
  // nobody is awaiting anymore (which would surface as an unhandled
  // rejection long after the flow ended).
  let cancelPending: (() => void) | null = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    async start(): Promise<LoopbackHandle> {
      let resolveCode!: (value: { code: string; state: string }) => void;
      let rejectCode!: (err: unknown) => void;
      codePromise = new Promise((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
      });
      // The timeout (or an early callback) can reject before waitForCode is
      // awaited — e.g. while openUrl is still in flight. Mark the rejection
      // handled so it never surfaces as an unhandled-rejection warning; the
      // real consumer (waitForCode) still receives it.
      codePromise.catch(() => {});
      // First settlement wins; later callbacks/timeouts are ignored.
      let settled = false;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimer();
        fn();
      };
      cancelPending = () =>
        settle(() => {
          /* abandoned via stop(): leave the promise forever-pending */
        });
      // The state waitForCode expects, registered as soon as it's called.
      // Until then (the sliver between the browser opening and waitForCode
      // being awaited) the handler accepts any callback and waitForCode's
      // own post-await check covers validation.
      let expectedState: string | null = null;

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
          settle(() => rejectCode(new UnifiedError("auth_user_cancelled", `oauth error: ${err}`)));
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || !state) {
          res.writeHead(400).end();
          settle(() =>
            rejectCode(
              new UnifiedError("auth_token_exchange_failed", "callback missing code/state"),
            ),
          );
          return;
        }
        // Anti-griefing: the callback promise settles winner-take-all, so a
        // local process racing the real browser with a bogus code+state must
        // NOT consume the settlement — reject only this HTTP request and keep
        // listening so the genuine redirect (with the matching state) still
        // wins. Callbacks arriving before waitForCode registers its state
        // fall through to the post-await check there.
        if (expectedState !== null && state !== expectedState) {
          res
            .writeHead(400, { "content-type": "text/html" })
            .end("<h1>Invalid sign-in callback</h1><p>State mismatch; still waiting.</p>");
          return;
        }
        res
          .writeHead(200, { "content-type": "text/html" })
          .end("<h1>Signed in</h1><p>You can close this window.</p>");
        settle(() => resolveCode({ code, state }));
      });
      const s = server;
      await new Promise<void>((resolve, reject) => {
        s.once("error", reject);
        s.listen(0, "127.0.0.1", () => resolve());
      });
      // Deadline for the redirect to arrive. Without it, a user who closes
      // the browser tab leaves waitForCode pending forever and the caller's
      // cleanup (loopback.stop()) never runs. unref'd so a pending sign-in
      // can't keep a CLI process alive on its own.
      timer = setTimeout(() => {
        settle(() =>
          rejectCode(
            new UnifiedError(
              "auth_timeout",
              `browser sign-in timed out after ${timeoutMs}ms waiting for the OAuth redirect`,
            ),
          ),
        );
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      const addr = s.address() as AddressInfo;
      const port = addr.port;
      const pending = codePromise;
      return {
        redirectUri: `http://127.0.0.1:${port}/callback`,
        async waitForCode(expected: string): Promise<string> {
          expectedState = expected;
          const { code, state } = await pending;
          if (state !== expected) {
            throw new UnifiedError("auth_state_mismatch", "oauth state mismatch");
          }
          return code;
        },
      };
    },
    async stop(): Promise<void> {
      // Neutralise the deadline before closing so a timer firing after stop
      // can't reject an abandoned promise (unhandled rejection).
      cancelPending?.();
      cancelPending = null;
      clearTimer();
      if (server) {
        const s = server;
        server = null;
        await new Promise<void>((resolve) => s.close(() => resolve()));
      }
    },
  };
}

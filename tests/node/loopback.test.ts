import { afterEach, describe, expect, test } from "bun:test";
import { signInWithBrowser } from "../../src/auth/browser-sign-in";
import { UnifiedError } from "../../src/core/errors";
import { createNodeLoopback } from "../../src/node/_internal/loopback";

// Negative-path coverage for the real browser-PKCE redirect listener. The
// happy path (matching state, no error) is exercised indirectly by the
// bootstrap/refresh/session suites via tests/fake-web-auth.ts; these tests
// pin the security-critical failure branches that map to normative
// PROTOCOL.md error codes:
//   - auth_state_mismatch        (CSRF/PKCE state defense)
//   - auth_user_cancelled        (?error= callback)
//   - auth_token_exchange_failed (callback missing code/state)
//   - auth_timeout               (redirect never arrives)
// plus the anti-griefing rule: a bogus-state callback must not consume the
// pending flow — the genuine redirect still wins.
describe("createNodeLoopback", () => {
  let loopback: ReturnType<typeof createNodeLoopback> | null = null;

  afterEach(async () => {
    if (loopback) await loopback.stop();
    loopback = null;
  });

  // Drive the callback and capture the result. The waitForCode promise is
  // turned into a settle-result via .then() synchronously (so a rejection
  // never floats as "unhandled"), mirroring runBrowserPkce which awaits
  // waitForCode before the browser redirect ever fires.
  async function driveCallback(
    expectedState: string,
    params: Record<string, string>,
  ): Promise<{ code: string } | { error: unknown }> {
    loopback = createNodeLoopback();
    const handle = await loopback.start();
    const settled = handle.waitForCode(expectedState).then(
      (code) => ({ code }) as const,
      (error) => ({ error }) as const,
    );
    const callback = new URL(handle.redirectUri);
    for (const [k, v] of Object.entries(params)) callback.searchParams.set(k, v);
    await fetch(callback.toString());
    return settled;
  }

  test("ignores a bogus-state callback; the genuine redirect still wins", async () => {
    // A local process racing the real browser with a forged code+state must
    // not consume the winner-take-all settlement. The listener answers the
    // bogus request with an error page and keeps waiting, so the genuine
    // callback (matching state) still resolves the flow.
    loopback = createNodeLoopback();
    const handle = await loopback.start();
    const settled = handle.waitForCode("real-state").then(
      (code) => ({ code }) as const,
      (error) => ({ error }) as const,
    );

    const bogus = new URL(handle.redirectUri);
    bogus.searchParams.set("code", "attacker-code");
    bogus.searchParams.set("state", "attacker-state");
    const bogusRes = await fetch(bogus.toString());
    expect(bogusRes.status).toBe(400);

    const genuine = new URL(handle.redirectUri);
    genuine.searchParams.set("code", "good-code");
    genuine.searchParams.set("state", "real-state");
    const genuineRes = await fetch(genuine.toString());
    expect(genuineRes.status).toBe(200);

    const result = await settled;
    expect("code" in result).toBe(true);
    expect((result as { code: string }).code).toBe("good-code");
  });

  test("callback landing before waitForCode still fails closed on mismatched state", async () => {
    // The handler-level state gate only engages once waitForCode registers
    // the expected state; a callback that sneaks in before that must still
    // be rejected by waitForCode's own post-await check.
    loopback = createNodeLoopback();
    const handle = await loopback.start();
    const early = new URL(handle.redirectUri);
    early.searchParams.set("code", "abc123");
    early.searchParams.set("state", "attacker-state");
    await fetch(early.toString());
    const result = await handle.waitForCode("expected-state").then(
      (code) => ({ code }) as const,
      (error) => ({ error }) as const,
    );
    expect("error" in result).toBe(true);
    const err = (result as { error: unknown }).error;
    expect(err).toBeInstanceOf(UnifiedError);
    expect((err as UnifiedError).code).toBe("auth_state_mismatch");
  });

  test("rejects with auth_user_cancelled on an ?error= callback", async () => {
    const result = await driveCallback("expected-state", { error: "access_denied" });
    expect("error" in result).toBe(true);
    const err = (result as { error: unknown }).error;
    expect(err).toBeInstanceOf(UnifiedError);
    expect((err as UnifiedError).code).toBe("auth_user_cancelled");
  });

  test("rejects with auth_token_exchange_failed when code/state are missing", async () => {
    // Neither code nor state present.
    const result = await driveCallback("expected-state", {});
    expect("error" in result).toBe(true);
    const err = (result as { error: unknown }).error;
    expect(err).toBeInstanceOf(UnifiedError);
    expect((err as UnifiedError).code).toBe("auth_token_exchange_failed");
  });

  test("resolves the code when state matches (happy path)", async () => {
    const result = await driveCallback("the-state", { code: "good-code", state: "the-state" });
    expect("code" in result).toBe(true);
    expect((result as { code: string }).code).toBe("good-code");
  });

  test("rejects with auth_timeout when the redirect never arrives", async () => {
    loopback = createNodeLoopback({ timeoutMs: 40 });
    const handle = await loopback.start();
    const result = await handle.waitForCode("some-state").then(
      (code) => ({ code }) as const,
      (error) => ({ error }) as const,
    );
    expect("error" in result).toBe(true);
    const err = (result as { error: unknown }).error;
    expect(err).toBeInstanceOf(UnifiedError);
    expect((err as UnifiedError).code).toBe("auth_timeout");
  });

  test("signInWithBrowser timeout surfaces auth_timeout and closes the server", async () => {
    // The user "closes the tab": openUrl succeeds but no callback ever hits
    // the loopback. Pre-fix this hung forever and the finally { stop() }
    // never ran; now the timeout rejects and the listener port is released.
    loopback = createNodeLoopback({ timeoutMs: 40 });
    let redirectUri = "";
    const err = await signInWithBrowser({
      clientId: "test-app",
      authorizeUrl: "http://127.0.0.1:1/oauth/authorize",
      tokenUrl: "http://127.0.0.1:1/oauth/token",
      openUrl: (url) => {
        redirectUri = new URL(url).searchParams.get("redirect_uri") ?? "";
      },
      loopback,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(UnifiedError);
    expect((err as UnifiedError).code).toBe("auth_timeout");
    // Server must be closed by signInWithBrowser's cleanup: the redirect URI
    // no longer accepts connections.
    expect(redirectUri).not.toBe("");
    const probe = await fetch(redirectUri).then(
      () => "reachable",
      () => "unreachable",
    );
    expect(probe).toBe("unreachable");
  });
});

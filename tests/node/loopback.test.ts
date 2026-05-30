import { afterEach, describe, expect, test } from "bun:test";
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

  test("rejects with auth_state_mismatch when returned state differs", async () => {
    // Server echoes a state that does NOT match what waitForCode expects —
    // models a forged/replayed authorization code. Dropping or inverting the
    // `state !== expectedState` check would let this resolve, failing the test.
    const result = await driveCallback("expected-state", {
      code: "abc123",
      state: "attacker-state",
    });
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
});

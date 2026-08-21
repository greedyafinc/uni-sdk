import { describe, expect, test } from "bun:test";
import type { DiscoveryReader } from "../../src/node/_internal/discovery";
import type { EnvReader } from "../../src/node/_internal/env";
import { InMemoryKeychain } from "../../src/node/_internal/keychain";
import { UnifiedAI } from "../../src/node/index";
import { startFakeApi } from "../fake-api";
import { startFakeWebAuth } from "../fake-web-auth";

const CLIENT = "app_test";
const USER = "user_test";
const emptyDiscovery: DiscoveryReader = { read: async () => null };
const noEnv: EnvReader = {
  read: () => ({ handoffPort: undefined, clientId: undefined }),
};

/** Minimal deferred so tests can hold the browser flow at the consent page. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("signOut racing an in-flight bootstrap", () => {
  test("signOut during pending browser PKCE: session stays signed_out, tokens discarded and revoked", async () => {
    const web = await startFakeWebAuth({ userId: USER, expectedClientId: CLIENT });
    const keychain = new InMemoryKeychain();
    // Hold the browser flow: capture the consent URL but don't follow the
    // redirect until the test says so — models a user mid-consent.
    const urlCaptured = deferred();
    let consentUrl = "";
    try {
      const sdk = new UnifiedAI({
        appId: CLIENT,
        tokenUrl: web.tokenUrl,
        authorizeUrl: web.authorizeUrl,
        keychain,
        env: noEnv,
        discovery: emptyDiscovery,
        openUrl: async (url) => {
          consentUrl = url;
          urlCaptured.resolve();
        },
      });
      const events: string[] = [];
      sdk.session.onChange((e) => events.push(e.type));

      // Start bootstrap; capture the rejection early so an unhandled
      // rejection can't fire while the test is awaiting other steps.
      const bootOutcome = sdk.bootstrap().then(
        () => "resolved" as const,
        (err: unknown) => err,
      );
      await urlCaptured.promise;

      // User signs out while the consent page is still open.
      await sdk.signOut();
      expect(sdk.session.status).toBe("signed_out");
      // No tokens existed yet, so signOut itself had nothing to revoke.
      expect(web.revokeCalls().length).toBe(0);

      // The abandoned browser flow now completes (user clicks "approve" in a
      // stale tab): authorize redirect → loopback → token exchange.
      await fetch(consentUrl, { redirect: "follow" });

      // bootstrap() must reject rather than resurrect the session.
      const outcome = await bootOutcome;
      expect(outcome).not.toBe("resolved");
      expect(outcome).toMatchObject({ code: "aborted" });

      // Session was NOT resurrected: still signed_out, no signedIn event ever
      // fired (in particular none after the signedOut event).
      expect(sdk.session.status).toBe("signed_out");
      expect(events).toContain("signedOut");
      expect(events).not.toContain("signedIn");
      expect(() => sdk.identity()).toThrow();

      // The freshly-minted tokens were neither kept in the keychain...
      expect(await keychain.get(CLIENT)).toBeNull();
      // ...nor left live server-side: exactly one revoke, for the refresh
      // token the abandoned flow minted.
      const revokes = web.revokeCalls();
      expect(revokes.length).toBe(1);
      expect(revokes[0]?.token.startsWith("web_refresh_")).toBe(true);
      expect(revokes[0]?.token_type_hint).toBe("refresh_token");
      expect(revokes[0]?.client_id).toBe(CLIENT);
    } finally {
      await web.stop();
    }
  });

  test("normal browser PKCE bootstrap is unaffected: signs in, persists, no revoke", async () => {
    const web = await startFakeWebAuth({ userId: USER, expectedClientId: CLIENT });
    const keychain = new InMemoryKeychain();
    try {
      const sdk = new UnifiedAI({
        appId: CLIENT,
        tokenUrl: web.tokenUrl,
        authorizeUrl: web.authorizeUrl,
        keychain,
        env: noEnv,
        discovery: emptyDiscovery,
        openUrl: async (url) => {
          await fetch(url, { redirect: "follow" });
        },
      });
      const events: string[] = [];
      sdk.session.onChange((e) => events.push(e.type));
      await sdk.bootstrap();
      expect(sdk.session.status).toBe("active");
      expect(events).toEqual(["signedIn"]);
      expect(sdk.identity()).toEqual({ user_id: USER, client_id: CLIENT });
      expect(await keychain.get(CLIENT)).not.toBeNull();
      expect(web.revokeCalls().length).toBe(0);

      // And a deliberate signOut → explicit bootstrap() still re-authenticates
      // (the generation guard must not treat a COMPLETED signOut as a race).
      await sdk.signOut();
      await sdk.bootstrap();
      expect(sdk.session.status).toBe("active");
      expect(sdk.identity()).toEqual({ user_id: USER, client_id: CLIENT });
    } finally {
      await web.stop();
    }
  });

  test("lazy auto-bootstrap request path: request rejects after concurrent signOut instead of using resurrected tokens", async () => {
    const web = await startFakeWebAuth({ userId: USER, expectedClientId: CLIENT });
    const api = await startFakeApi(["a"]);
    const keychain = new InMemoryKeychain();
    const urlCaptured = deferred();
    let consentUrl = "";
    try {
      const sdk = new UnifiedAI({
        appId: CLIENT,
        apiUrl: api.baseUrl,
        tokenUrl: web.tokenUrl,
        authorizeUrl: web.authorizeUrl,
        keychain,
        env: noEnv,
        discovery: emptyDiscovery,
        openUrl: async (url) => {
          consentUrl = url;
          urlCaptured.resolve();
        },
      });
      // No explicit bootstrap() — the request path runs the ladder itself and
      // ends up holding at the browser consent page.
      const requestOutcome = sdk.request("/v1/ping").then(
        () => "resolved" as const,
        (err: unknown) => err,
      );
      await urlCaptured.promise;

      await sdk.signOut();
      await fetch(consentUrl, { redirect: "follow" });

      const outcome = await requestOutcome;
      expect(outcome).not.toBe("resolved");
      expect(outcome).toMatchObject({ code: "aborted" });
      // No API call ever carried the resurrected token.
      expect(api.requestCount()).toBe(0);
      expect(sdk.session.status).toBe("signed_out");
      expect(await keychain.get(CLIENT)).toBeNull();
      // The abandoned flow's fresh refresh token was revoked best-effort.
      expect(web.revokeCalls().some((c) => c.token.startsWith("web_refresh_"))).toBe(true);
      // Signed-out stays terminal for the request path afterwards.
      await expect(sdk.request("/v1/ping")).rejects.toMatchObject({ code: "not_bootstrapped" });
    } finally {
      await api.stop();
      await web.stop();
    }
  });
});

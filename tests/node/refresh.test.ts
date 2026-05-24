import { describe, expect, test } from "bun:test";
import { InMemoryKeychain } from "../../src/node/_internal/keychain";
import { UnifiedAI, UnifiedAIAuthError } from "../../src/node/index";
import { startFakeApi } from "../fake-api";
import { startFakeWebAuth } from "../fake-web-auth";

const CLIENT = "app_test";
const USER = "user_test";

interface Harness {
  sdk: UnifiedAI;
  api: Awaited<ReturnType<typeof startFakeApi>>;
  web: Awaited<ReturnType<typeof startFakeWebAuth>>;
  keychain: InMemoryKeychain;
  cleanup: () => Promise<void>;
}

// Bootstrap via a real PKCE round-trip against the fake web auth server so
// the refresh token is one the fake will actually accept on /oauth/token.
async function startSdk(): Promise<Harness> {
  const web = await startFakeWebAuth({ userId: USER, expectedClientId: CLIENT });
  const api = await startFakeApi();
  const keychain = new InMemoryKeychain();
  const sdk = new UnifiedAI({
    appId: CLIENT,
    apiUrl: api.baseUrl,
    tokenUrl: web.tokenUrl,
    authorizeUrl: web.authorizeUrl,
    keychain,
    env: { read: () => ({ handoffPort: undefined, clientId: undefined }) },
    discovery: { read: async () => null },
    openUrl: async (url) => {
      await fetch(url, { redirect: "follow" });
    },
  });
  await sdk.bootstrap();
  const tokens = (await keychain.get(CLIENT)) as NonNullable<
    Awaited<ReturnType<InMemoryKeychain["get"]>>
  >;
  api.setValidAccessTokens([tokens.access_token]);
  // Whenever the SDK persists a refreshed token, keep the api's accepted-token
  // set in sync. This is the test-side mirror of "new access token is now live".
  const origSet = keychain.set.bind(keychain);
  keychain.set = async (id, t) => {
    api.setValidAccessTokens([t.access_token]);
    return origSet(id, t);
  };
  return {
    sdk,
    api,
    web,
    keychain,
    cleanup: async () => {
      await api.stop();
      await web.stop();
    },
  };
}

describe("transport refresh-on-401", () => {
  test("401 then 200 round-trip: transparent refresh", async () => {
    const h = await startSdk();
    try {
      h.api.setValidAccessTokens([]); // current access token is now expired
      const result = await h.sdk.request<{ ok: boolean }>("/v1/ping");
      expect(result.ok).toBe(true);
      expect(h.web.refreshCallCount()).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test("N concurrent 401s trigger exactly one refresh", async () => {
    const h = await startSdk();
    try {
      h.api.setValidAccessTokens([]);
      const N = 8;
      const results = await Promise.all(
        Array.from({ length: N }, () => h.sdk.request<{ ok: boolean }>("/v1/ping")),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      expect(h.web.refreshCallCount()).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test("refresh failure throws UnifiedAIAuthError and clears keychain", async () => {
    const h = await startSdk();
    try {
      h.api.setValidAccessTokens([]);
      h.web.revokeRefreshTokens();
      await expect(h.sdk.request("/v1/ping")).rejects.toBeInstanceOf(UnifiedAIAuthError);
      expect(await h.keychain.get(CLIENT)).toBeNull();
    } finally {
      await h.cleanup();
    }
  });

  test("retry-still-401 throws UnifiedAIAuthError and clears keychain", async () => {
    const h = await startSdk();
    try {
      h.api.forceAlways401(true);
      await expect(h.sdk.request("/v1/ping")).rejects.toBeInstanceOf(UnifiedAIAuthError);
      expect(await h.keychain.get(CLIENT)).toBeNull();
    } finally {
      await h.cleanup();
    }
  });

  test("successful refresh persists new tokens to keychain", async () => {
    const h = await startSdk();
    try {
      const before = (await h.keychain.get(CLIENT)) as NonNullable<
        Awaited<ReturnType<InMemoryKeychain["get"]>>
      >;
      h.api.setValidAccessTokens([]);
      await h.sdk.request("/v1/ping");
      const after = (await h.keychain.get(CLIENT)) as NonNullable<
        Awaited<ReturnType<InMemoryKeychain["get"]>>
      >;
      expect(after.access_token).not.toBe(before.access_token);
      expect(after.refresh_token).not.toBe(before.refresh_token);
    } finally {
      await h.cleanup();
    }
  });

  test("signOut during in-flight refresh does NOT re-persist tokens", async () => {
    // Regression for the race where a refresh started just before signOut()
    // resolved afterwards and called this.persist(), undoing the sign-out by
    // restoring tokens into the instance + keychain.
    //
    // Deterministic timing: pause the /oauth/token endpoint so the refresh
    // POST blocks at the server; wait for the SDK to actually dispatch it;
    // run signOut to completion; THEN release the refresh response. This
    // guarantees the generation-guard branch in ensureFreshToken's .then is
    // the path under test (not the `!current` early-return that fires when
    // signOut clears tokens before the refresh even starts).
    const h = await startSdk();
    try {
      h.api.setValidAccessTokens([]);
      h.web.pauseRefresh();
      const refreshStarted = h.web.waitForRefreshStarted();

      const inflight = h.sdk.request("/v1/ping").catch((err) => err);
      await refreshStarted; // refresh POST is at the server, waiting for release

      await h.sdk.signOut(); // bumps generation; in-flight refresh is now invalid
      h.web.releaseRefresh(); // let the refresh response arrive

      const result = await inflight;

      expect(await h.keychain.get(CLIENT)).toBeNull();
      expect(result).toBeInstanceOf(UnifiedAIAuthError);
      expect(() => h.sdk.identity()).toThrow();
      // The generation guard must have actually run — i.e. the refresh
      // really did complete and was then rejected, not skipped entirely.
      expect(h.web.refreshCallCount()).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test("signOut revokes the ORIGINAL refresh family even when a refresh is in flight", async () => {
    // Tighter regression: prove the server-side leak is closed. Before the
    // fix, an in-flight refresh that resolved between revoke and
    // clearLocalSession would persist a NEW refresh-token family that was
    // never sent to /oauth/revoke.
    const h = await startSdk();
    try {
      const original = (await h.keychain.get(CLIENT)) as NonNullable<
        Awaited<ReturnType<InMemoryKeychain["get"]>>
      >;

      h.api.setValidAccessTokens([]);
      h.web.pauseRefresh();
      const refreshStarted = h.web.waitForRefreshStarted();

      const inflight = h.sdk.request("/v1/ping").catch((err) => err);
      await refreshStarted;

      await h.sdk.signOut();
      h.web.releaseRefresh();
      await inflight;

      const revokes = h.web.revokeCalls();
      // Exactly one revoke call, targeting the ORIGINAL refresh_token —
      // never a freshly-rotated one issued by an in-flight refresh.
      expect(revokes.length).toBe(1);
      expect(revokes[0]?.token).toBe(original.refresh_token);
      expect(revokes[0]?.client_id).toBe(original.client_id);

      expect(await h.keychain.get(CLIENT)).toBeNull();
      expect(h.web.refreshCallCount()).toBe(1);
    } finally {
      await h.cleanup();
    }
  });

  test("signOut completes within timeout when revoke endpoint hangs", async () => {
    // Regression: revokeToken used to await fetch() with no AbortSignal, so a
    // black-holed /oauth/revoke endpoint would wedge signOut forever. The
    // timeout (default 5000ms; we pass 100ms here) must abort the revoke and
    // let signOut proceed to clearLocalSession.
    const web = await startFakeWebAuth({ userId: USER, expectedClientId: CLIENT });
    const api = await startFakeApi();
    const keychain = new InMemoryKeychain();
    const sdk = new UnifiedAI({
      appId: CLIENT,
      apiUrl: api.baseUrl,
      tokenUrl: web.tokenUrl,
      authorizeUrl: web.authorizeUrl,
      keychain,
      env: { read: () => ({ handoffPort: undefined, clientId: undefined }) },
      discovery: { read: async () => null },
      openUrl: async (url) => {
        await fetch(url, { redirect: "follow" });
      },
      revokeTimeoutMs: 100,
    });
    try {
      await sdk.bootstrap();
      web.hangRevoke();

      const start = Date.now();
      await sdk.signOut();
      const elapsed = Date.now() - start;

      // Must finish within a small margin of the timeout — definitely not the
      // unbounded hang we used to have. Lower bound catches a regression that
      // disables the timer entirely (e.g. timeoutMs=0 misinterpretation): such
      // a regression would return in ~0ms and silently skip every revoke.
      expect(elapsed).toBeGreaterThanOrEqual(80);
      expect(elapsed).toBeLessThan(2000);
      // Local state must still be cleared despite the revoke being abandoned.
      expect(await keychain.get(CLIENT)).toBeNull();
      // And the revoke was at least attempted (recorded by the fake server).
      expect(web.revokeCalls().length).toBe(1);
    } finally {
      await api.stop();
      await web.stop();
    }
  });

  test("bootstrap during signOut's revoke wait survives the trailing clear", async () => {
    // Regression: signOut used to await revokeToken (up to 5s) BEFORE
    // running clearLocalSession. A bootstrap() that landed during that wait
    // would re-establish a session, then signOut's trailing clearLocalSession
    // would wipe it. Fixed by reordering signOut to clear-first.
    const web = await startFakeWebAuth({ userId: USER, expectedClientId: CLIENT });
    const api = await startFakeApi();
    const keychain = new InMemoryKeychain();

    // Two SDK instances sharing the same keychain — models "user signs out,
    // then signs back in" via a new SDK instance built on the same keychain
    // (typical of a page-reload-driven app, or a session-restart flow).
    const buildSdk = () =>
      new UnifiedAI({
        appId: CLIENT,
        apiUrl: api.baseUrl,
        tokenUrl: web.tokenUrl,
        authorizeUrl: web.authorizeUrl,
        keychain,
        env: { read: () => ({ handoffPort: undefined, clientId: undefined }) },
        discovery: { read: async () => null },
        openUrl: async (url) => {
          await fetch(url, { redirect: "follow" });
        },
        revokeTimeoutMs: 500,
      });
    try {
      const sdkA = buildSdk();
      await sdkA.bootstrap();
      const originalTokens = (await keychain.get(CLIENT)) as NonNullable<
        Awaited<ReturnType<InMemoryKeychain["get"]>>
      >;

      // Hold revoke at the server so signOut's revoke await stalls until we
      // explicitly let it through.
      web.hangRevoke();
      const revokeRequested = web.waitForRevokeRequest();

      // Kick off signOut on sdkA — do NOT await; we want bootstrap to race.
      const signOutDone = sdkA.signOut();

      // Deterministic synchronization: wait until signOut has actually
      // reached its revoke fetch. By the time the server receives the
      // revoke POST, clearLocalSession (which precedes it in signOut) has
      // necessarily completed, so the keychain is clear and sdkB.bootstrap
      // cannot take the cached-tokens early-return.
      await revokeRequested;

      // Fresh SDK instance attempts to bootstrap during signOut's wait. The
      // keychain was cleared by sdkA's signOut, so this MUST run full PKCE
      // and persist a new family.
      const sdkB = buildSdk();
      await sdkB.bootstrap();
      const newTokens = (await keychain.get(CLIENT)) as NonNullable<
        Awaited<ReturnType<InMemoryKeychain["get"]>>
      >;

      // Let signOut's revoke time out (revokeTimeoutMs=500 above).
      await signOutDone;

      // Critical: the new family persisted by sdkB must still be in the
      // keychain after sdkA's signOut completed. If signOut had run
      // clearLocalSession AFTER the revoke wait, this would be null.
      const finalKeychain = await keychain.get(CLIENT);
      expect(finalKeychain).not.toBeNull();
      expect(finalKeychain?.refresh_token).toBe(newTokens.refresh_token);
      expect(finalKeychain?.refresh_token).not.toBe(originalTokens.refresh_token);

      // sdkB's identity is still usable.
      expect(() => sdkB.identity()).not.toThrow();
    } finally {
      await api.stop();
      await web.stop();
    }
  });

  test("revoke runs and then signOut rethrows when keychain.clear fails", async () => {
    // Regression: with the clear-first reorder, a throw from keychain.clear
    // used to skip the trailing revoke — leaving the server-side family
    // live. signOut now wraps clearLocalSession in try/catch, runs revoke
    // against the captured snapshot regardless, then rethrows so callers
    // see the keychain failure.
    const web = await startFakeWebAuth({ userId: USER, expectedClientId: CLIENT });
    const api = await startFakeApi();

    // Custom keychain that throws on clear but otherwise behaves normally.
    const store = new Map<string, Awaited<ReturnType<InMemoryKeychain["get"]>>>();
    const flakyKeychain = {
      get: async (id: string) => store.get(id) ?? null,
      set: async (id: string, t: NonNullable<Awaited<ReturnType<InMemoryKeychain["get"]>>>) => {
        store.set(id, t);
      },
      clear: async () => {
        throw new Error("simulated keychain clear failure");
      },
    };

    const sdk = new UnifiedAI({
      appId: CLIENT,
      apiUrl: api.baseUrl,
      tokenUrl: web.tokenUrl,
      authorizeUrl: web.authorizeUrl,
      keychain: flakyKeychain,
      env: { read: () => ({ handoffPort: undefined, clientId: undefined }) },
      discovery: { read: async () => null },
      openUrl: async (url) => {
        await fetch(url, { redirect: "follow" });
      },
    });
    try {
      await sdk.bootstrap();
      const original = (await flakyKeychain.get(CLIENT)) as NonNullable<
        Awaited<ReturnType<InMemoryKeychain["get"]>>
      >;

      let thrown: unknown;
      try {
        await sdk.signOut();
      } catch (err) {
        thrown = err;
      }

      // The keychain failure must surface to the caller — they need to know
      // local cleanup didn't fully succeed.
      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).toContain("simulated keychain clear failure");

      // And critically: the server-side revoke STILL ran with the ORIGINAL
      // refresh_token, despite the keychain throw. Without the try/catch
      // around clearLocalSession this assertion would fail (revoke skipped).
      const revokes = web.revokeCalls();
      expect(revokes.length).toBe(1);
      expect(revokes[0]?.token).toBe(original.refresh_token);
    } finally {
      await api.stop();
      await web.stop();
    }
  });

  test("signOut tolerates a throwing keychain.get on the snapshot fallback", async () => {
    // Regression: round-7 guarded keychain.clear failures but the symmetric
    // snapshot read `await this.keychain.get(clientId)` (when in-memory
    // tokens are missing) was OUTSIDE the try/catch. A throwing .get would
    // bypass both clearLocalSession AND revoke. Round 8 wraps the snapshot
    // read so a throwing .get produces snapshot=null and signOut still
    // clears local state without throwing.
    //
    // To actually exercise the snapshot.get branch (instead of the
    // this.tokens branch), we use TWO SDK instances sharing a keychain:
    // sdkA bootstraps to populate the keychain; sdkB is a fresh instance
    // with `this.tokens === undefined` so its signOut must fall through to
    // the keychain.get path — which throws.
    const web = await startFakeWebAuth({ userId: USER, expectedClientId: CLIENT });
    const api = await startFakeApi();

    let stored: NonNullable<Awaited<ReturnType<InMemoryKeychain["get"]>>> | null = null;
    // SDK A uses a normal keychain so bootstrap can persist tokens.
    const normalKeychain = {
      get: async (_id: string) => stored,
      set: async (_id: string, t: NonNullable<Awaited<ReturnType<InMemoryKeychain["get"]>>>) => {
        stored = t;
      },
      clear: async () => {
        stored = null;
      },
    };
    // SDK B uses a keychain whose .get always throws but .clear works,
    // modeling a transient adapter failure on the get path.
    const flakyGetKeychain = {
      get: async (_id: string) => {
        throw new Error("simulated keychain.get failure");
      },
      set: normalKeychain.set,
      clear: normalKeychain.clear,
    };

    const buildSdk = (kc: typeof normalKeychain) =>
      new UnifiedAI({
        appId: CLIENT,
        apiUrl: api.baseUrl,
        tokenUrl: web.tokenUrl,
        authorizeUrl: web.authorizeUrl,
        keychain: kc,
        env: { read: () => ({ handoffPort: undefined, clientId: undefined }) },
        discovery: { read: async () => null },
        openUrl: async (url) => {
          await fetch(url, { redirect: "follow" });
        },
      });

    try {
      // Bootstrap sdkA → keychain is populated.
      const sdkA = buildSdk(normalKeychain);
      await sdkA.bootstrap();
      expect(stored).not.toBeNull();

      // Construct sdkB with the get-throwing keychain. Do NOT bootstrap so
      // sdkB.this.tokens stays undefined → snapshot read MUST fall through
      // to keychain.get, which throws.
      const sdkB = buildSdk(flakyGetKeychain);

      // signOut must NOT throw (snapshot read is now guarded). It also
      // skips revoke because the snapshot is unavailable.
      await sdkB.signOut();

      // Pre-fix: this would have thrown 'simulated keychain.get failure'
      // and the keychain entry would still be populated. Post-fix:
      // snapshot=null, no revoke attempted, clearLocalSession ran and
      // cleared the keychain (the same `stored` shared with sdkA).
      expect(stored).toBeNull();
      // No revoke recorded since the snapshot was unavailable.
      expect(web.revokeCalls().length).toBe(0);
    } finally {
      await api.stop();
      await web.stop();
    }
  });

  test("signOut tolerates `throw undefined` from keychain.clear (boolean sentinel)", async () => {
    // Regression: an earlier version used `clearError !== undefined` as the
    // sentinel for 'no error captured'. A cursed-but-legal `throw undefined`
    // from a custom adapter would set clearError=undefined and silently
    // swallow the failure. Round 8 switched to a boolean sentinel so the
    // throw is faithfully surfaced even when the thrown value is undefined.
    const web = await startFakeWebAuth({ userId: USER, expectedClientId: CLIENT });
    const api = await startFakeApi();

    let storedTokens: NonNullable<Awaited<ReturnType<InMemoryKeychain["get"]>>> | null = null;
    const undefinedThrowingKeychain = {
      get: async (_id: string) => storedTokens,
      set: async (_id: string, t: NonNullable<Awaited<ReturnType<InMemoryKeychain["get"]>>>) => {
        storedTokens = t;
      },
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      clear: async () => {
        throw undefined;
      },
    };

    const sdk = new UnifiedAI({
      appId: CLIENT,
      apiUrl: api.baseUrl,
      tokenUrl: web.tokenUrl,
      authorizeUrl: web.authorizeUrl,
      keychain: undefinedThrowingKeychain,
      env: { read: () => ({ handoffPort: undefined, clientId: undefined }) },
      discovery: { read: async () => null },
      openUrl: async (url) => {
        await fetch(url, { redirect: "follow" });
      },
    });
    try {
      await sdk.bootstrap();

      let didThrow = false;
      let thrown: unknown;
      try {
        await sdk.signOut();
      } catch (err) {
        didThrow = true;
        thrown = err;
      }

      // Even though the keychain threw `undefined`, signOut must rethrow it
      // (not silently resolve). The thrown value here IS undefined — what
      // matters is that didThrow is true.
      expect(didThrow).toBe(true);
      expect(thrown).toBeUndefined(); // faithful pass-through

      // And revoke must still have run despite the cursed throw.
      expect(web.revokeCalls().length).toBe(1);
    } finally {
      await api.stop();
      await web.stop();
    }
  });
});

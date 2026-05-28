import { describe, expect, test } from "bun:test";
import { Session, type SessionEvent } from "../../src/core/session";
import { UnifiedAI } from "../../src/index";

const okFetch = (async () =>
  new Response("{}", {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

describe("session surface (browser / trusted-token)", () => {
  test("a configured token reports authenticated", () => {
    const sdk = new UnifiedAI({ token: "abc" });
    expect(sdk.session.isAuthenticated()).toBe(true);
    expect(sdk.session.status).toBe("active");
    // No expiry/identity is knowable — the host owns the lifecycle.
    expect(sdk.session.expiresAt).toBeUndefined();
    expect(sdk.session.identity).toBeUndefined();
  });

  test("no token reports unauthenticated", () => {
    const sdk = new UnifiedAI();
    expect(sdk.session.isAuthenticated()).toBe(false);
    expect(sdk.session.status).toBe("signed_out");
  });

  test("signOut emits signedOut and flips isAuthenticated", async () => {
    const sdk = new UnifiedAI({ token: "abc" });
    const events: SessionEvent[] = [];
    sdk.session.onChange((e) => events.push(e));

    await sdk.signOut();

    expect(events.map((e) => e.type)).toEqual(["signedOut"]);
    expect(sdk.session.isAuthenticated()).toBe(false);
  });

  test("a 401-driven token re-resolve emits a single refreshed event", async () => {
    let calls = 0;
    const STALE = "stale";
    const FRESH = "fresh";
    const fakeFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? "";
      if (auth.endsWith(FRESH))
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      return new Response("", { status: 401 });
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: () => {
        calls++;
        return calls === 1 ? STALE : FRESH;
      },
    });
    const events: SessionEvent[] = [];
    sdk.session.onChange((e) => events.push(e));

    await sdk.usage.get();

    expect(events.map((e) => e.type)).toEqual(["refreshed"]);
  });

  test("signed_out is terminal: a late refresh/expiry cannot override it", () => {
    const session = new Session("active");
    const events: SessionEvent[] = [];
    session.onChange((e) => events.push(e));

    session.markSignedOut();
    // A refresh or expiry that resolves after sign-out must be ignored — only
    // an explicit re-sign-in reactivates the session.
    session.markRefreshed({ expiresAt: Date.now() + 60_000 });
    session.markExpired();

    expect(session.status).toBe("signed_out");
    expect(session.isAuthenticated()).toBe(false);
    expect(events.map((e) => e.type)).toEqual(["signedOut"]);

    // An explicit sign-in still works after sign-out.
    session.markSignedIn({ identity: { user_id: "u", client_id: "c" } });
    expect(session.status).toBe("active");
    expect(events.map((e) => e.type)).toEqual(["signedOut", "signedIn"]);
  });

  test("onChange unsubscribe stops delivery", async () => {
    const sdk = new UnifiedAI({ apiUrl: "https://example.test", fetch: okFetch, token: "abc" });
    const events: SessionEvent[] = [];
    const unsubscribe = sdk.session.onChange((e) => events.push(e));
    unsubscribe();

    await sdk.signOut();
    expect(events).toEqual([]);
  });
});

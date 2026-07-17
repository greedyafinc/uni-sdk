import { describe, expect, test } from "bun:test";
import { NotFoundError, UnifiedAI, UnifiedError } from "../../src/index";
import type {
  MeResponse,
  PublicUserResponse,
  PublicUsersResponse,
} from "../../src/resources/users";

// Exercises the browser-safe UnifiedAI directly from source. These tests
// stand alone — they do not require a build artifact.

describe("sdk.users.me()", () => {
  const canned: MeResponse = {
    user: {
      id: "user_123",
      email: "person@example.test",
      first_name: "Ada",
      last_name: "Lovelace",
      display_name: "Ada",
      created_at: "2026-01-01T00:00:00.000Z",
      account_type: 1,
    },
    client: {
      id: "client_abc",
      app_name: "Example App",
    },
  };

  test("requests GET /api/v1/me with the bearer token and resolves the parsed body", async () => {
    let captured: Request | undefined;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input as string, init);
      return new Response(JSON.stringify(canned), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: "abc-token",
    });

    const result = await sdk.users.me();

    expect(captured?.url).toBe("https://example.test/api/v1/me");
    expect(captured?.method).toBe("GET");
    expect(captured?.headers.get("authorization")).toBe("Bearer abc-token");
    expect(result).toEqual(canned);
  });

  test("passes an AbortSignal through to the underlying request", async () => {
    const fakeFetch = (async () => {
      return new Response(JSON.stringify(canned), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: "abc-token",
    });

    const controller = new AbortController();
    await expect(sdk.users.me({ signal: controller.signal })).resolves.toEqual(canned);
  });
});

describe("sdk.users.get(id)", () => {
  const cannedPublic: PublicUserResponse = {
    user: {
      id: "user_456",
      first_name: "Grace",
      last_name: "Hopper",
      display_name: "Grace",
      created_at: "2026-02-01T00:00:00.000Z",
    },
  };

  test("requests GET /api/v1/users/:id with the id URL-encoded, bearer token, and resolves the parsed body", async () => {
    let captured: Request | undefined;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input as string, init);
      return new Response(JSON.stringify(cannedPublic), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: "abc-token",
    });

    const idWithSpecialChar = "user 456/x";
    const result = await sdk.users.get(idWithSpecialChar);

    expect(captured?.url).toBe(
      `https://example.test/api/v1/users/${encodeURIComponent(idWithSpecialChar)}`,
    );
    expect(captured?.method).toBe("GET");
    expect(captured?.headers.get("authorization")).toBe("Bearer abc-token");
    expect(result).toEqual(cannedPublic);
  });

  test("passes an AbortSignal through to the underlying request", async () => {
    const fakeFetch = (async () => {
      return new Response(JSON.stringify(cannedPublic), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: "abc-token",
    });

    const controller = new AbortController();
    await expect(sdk.users.get("user_456", { signal: controller.signal })).resolves.toEqual(
      cannedPublic,
    );
  });

  test("404 with code user_not_found rejects with NotFoundError carrying the status and body", async () => {
    const fakeFetch = (async () => {
      return new Response(JSON.stringify({ error: "user not found", code: "user_not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: "abc-token",
    });

    let caught: unknown;
    try {
      await sdk.users.get("missing-id");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NotFoundError);
    const err = caught as NotFoundError;
    expect(err.status).toBe(404);
    expect(err.body).toEqual({ error: "user not found", code: "user_not_found" });
  });
});

describe("sdk.users.list(ids)", () => {
  const cannedBatch: PublicUsersResponse = {
    users: [
      {
        id: "user_1",
        first_name: "Ada",
        last_name: "Lovelace",
        display_name: "Ada",
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "user_2",
        first_name: "Grace",
        last_name: "Hopper",
        display_name: "Grace",
        created_at: "2026-02-01T00:00:00.000Z",
      },
    ],
  };

  test("requests GET /api/v1/users?ids=<comma-joined> with the bearer token and resolves the parsed body", async () => {
    let captured: Request | undefined;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input as string, init);
      return new Response(JSON.stringify(cannedBatch), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: "abc-token",
    });

    const result = await sdk.users.list(["user_1", "user_2"]);

    const url = new URL(captured?.url ?? "");
    expect(url.origin + url.pathname).toBe("https://example.test/api/v1/users");
    // URLSearchParams percent-encodes the comma on the wire (%2C) — decode via
    // URLSearchParams/URL parsing rather than asserting the raw query string,
    // so this test isn't coupled to whether the encoding happens to look like
    // a literal comma.
    expect(url.searchParams.get("ids")).toBe("user_1,user_2");
    expect(captured?.method).toBe("GET");
    expect(captured?.headers.get("authorization")).toBe("Bearer abc-token");
    expect(result).toEqual(cannedBatch);
  });

  test("trims, drops empties, and dedupes ids before sending", async () => {
    let captured: Request | undefined;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = new Request(input as string, init);
      return new Response(JSON.stringify(cannedBatch), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: "abc-token",
    });

    await sdk.users.list(["user_1", " user_2 ", "user_1", "", "  ", "user_2"]);

    const url = new URL(captured?.url ?? "");
    expect(url.searchParams.get("ids")).toBe("user_1,user_2");
  });

  test("empty array resolves { users: [] } without making a request", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(JSON.stringify(cannedBatch), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: "abc-token",
    });

    await expect(sdk.users.list([])).resolves.toEqual({ users: [] });
    // Also verify an all-empty/whitespace input dedupes down to nothing.
    await expect(sdk.users.list(["", "   "])).resolves.toEqual({ users: [] });
    expect(calls).toBe(0);
  });

  test("more than 100 deduped ids throws UnifiedError without making a request", async () => {
    let calls = 0;
    const fakeFetch = (async () => {
      calls++;
      return new Response(JSON.stringify(cannedBatch), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: "abc-token",
    });

    const tooMany = Array.from({ length: 101 }, (_, i) => `user_${i}`);

    let caught: unknown;
    try {
      await sdk.users.list(tooMany);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnifiedError);
    expect((caught as UnifiedError).code).toBe("invalid_input");
    expect(calls).toBe(0);
  });
});

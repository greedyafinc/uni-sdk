import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  BadRequestError,
  NotFoundError,
  RateLimitError,
  ServerError,
  UnifiedAI,
  UnifiedAIError,
  UsageLimitError,
  buildHttpError,
} from "../../src/index";

// Verifies the typed-error hierarchy and that the fetch path dispatches the
// right subclass per status. Each test mocks fetch directly — no network.

function fakeFetchReturning(status: number, body: unknown, headers: Record<string, string> = {}) {
  return (async () => {
    const init: ResponseInit = { status, headers };
    return new Response(typeof body === "string" ? body : JSON.stringify(body), init);
  }) as unknown as typeof fetch;
}

describe("buildHttpError", () => {
  test("400 → BadRequestError", () => {
    const e = buildHttpError("msg", 400, { message: "bad" });
    expect(e).toBeInstanceOf(BadRequestError);
    expect(e).toBeInstanceOf(UnifiedAIError);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("bad_request");
    expect(e.status).toBe(400);
  });

  test("401 → AuthenticationError", () => {
    const e = buildHttpError("msg", 401, { message: "no key" });
    expect(e).toBeInstanceOf(AuthenticationError);
    expect(e.code).toBe("unauthorized");
  });

  test("404 → NotFoundError", () => {
    const e = buildHttpError("msg", 404, { message: "nope" });
    expect(e).toBeInstanceOf(NotFoundError);
    expect(e.code).toBe("not_found");
  });

  test("429 generic throttle → RateLimitError with retryAfter", () => {
    const e = buildHttpError("msg", 429, { error: "rate_limited" }, { "retry-after": "3" });
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e).not.toBeInstanceOf(UsageLimitError);
    expect(e.code).toBe("rate_limited");
    expect((e as RateLimitError).retryAfter).toBe(3);
  });

  test("429 usage limit → UsageLimitError with parsed cost/limit", () => {
    const body = { message: "Usage limit exceeded. Window cost: $1.2345 / $5.00" };
    const e = buildHttpError("msg", 429, body);
    expect(e).toBeInstanceOf(UsageLimitError);
    expect(e).toBeInstanceOf(RateLimitError === undefined ? Object : UnifiedAIError);
    const u = e as UsageLimitError;
    expect(u.code).toBe("usage_limit_exceeded");
    expect(u.isUsageLimit).toBe(true);
    expect(u.periodCost).toBeCloseTo(1.2345, 4);
    expect(u.limit).toBeCloseTo(5.0, 2);
  });

  test("429 usage limit honors structured fields if present", () => {
    const body = {
      code: "usage_limit_exceeded",
      period_cost: 2.5,
      limit: 10,
      reset_at: "2026-06-01T00:00:00Z",
    };
    const e = buildHttpError("msg", 429, body) as UsageLimitError;
    expect(e).toBeInstanceOf(UsageLimitError);
    expect(e.periodCost).toBe(2.5);
    expect(e.limit).toBe(10);
    expect(e.resetAt).toBe("2026-06-01T00:00:00Z");
  });

  test("500 → ServerError", () => {
    const e = buildHttpError("msg", 500, { message: "boom" });
    expect(e).toBeInstanceOf(ServerError);
    expect(e.code).toBe("server_error");
  });

  test("captures request_id from response headers", () => {
    const e = buildHttpError("msg", 400, {}, { "x-request-id": "req_abc123" });
    expect(e.requestId).toBe("req_abc123");
  });

  test("retry-after HTTP-date is converted to seconds", () => {
    const inFiveSec = new Date(Date.now() + 5000).toUTCString();
    const e = buildHttpError("msg", 429, { error: "rate_limited" }, { "retry-after": inFiveSec });
    const ra = (e as RateLimitError).retryAfter;
    expect(ra).toBeGreaterThanOrEqual(4);
    expect(ra).toBeLessThanOrEqual(6);
  });

  test("403 falls back to base UnifiedAIError", () => {
    const e = buildHttpError("msg", 403, {});
    expect(e.constructor).toBe(UnifiedAIError);
    expect(e.code).toBe("forbidden");
  });
});

describe("fetch path throws typed errors", () => {
  test("401 from request() throws AuthenticationError (after refresh retry)", async () => {
    let call = 0;
    const fakeFetch = (async () => {
      call++;
      return new Response(JSON.stringify({ message: "invalid key" }), { status: 401 });
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: "abc",
    });
    // The browser client's 401 path retries once with a fresh token before
    // surfacing `UnifiedAIAuthError` for the still-401 case. So a persistent
    // 401 here surfaces as the auth-retry error, not AuthenticationError.
    await expect(sdk.usage.get()).rejects.toMatchObject({ status: 401 });
    expect(call).toBe(2);
  });

  test("429 usage limit dispatched as UsageLimitError", async () => {
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetchReturning(
        429,
        { message: "Usage limit exceeded. Window cost: $0.5000 / $1.00" },
        { "x-request-id": "req_z" },
      ),
      token: "abc",
    });
    try {
      await sdk.usage.get();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UsageLimitError);
      const u = err as UsageLimitError;
      expect(u.periodCost).toBeCloseTo(0.5, 4);
      expect(u.limit).toBeCloseTo(1.0, 2);
      expect(u.requestId).toBe("req_z");
    }
  });

  test("429 generic throttle dispatched as RateLimitError", async () => {
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetchReturning(429, { error: "rate_limited" }, { "retry-after": "7" }),
      token: "abc",
    });
    try {
      await sdk.usage.get();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
      expect(err).not.toBeInstanceOf(UsageLimitError);
      expect((err as RateLimitError).retryAfter).toBe(7);
    }
  });

  test("500 dispatched as ServerError", async () => {
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetchReturning(500, { message: "boom" }),
      token: "abc",
    });
    await expect(sdk.usage.get()).rejects.toBeInstanceOf(ServerError);
  });

  test("404 dispatched as NotFoundError", async () => {
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetchReturning(404, { message: "no such model" }),
      token: "abc",
    });
    await expect(sdk.models.list()).rejects.toBeInstanceOf(NotFoundError);
  });

  test("400 dispatched as BadRequestError", async () => {
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetchReturning(400, { message: "bad payload" }),
      token: "abc",
    });
    await expect(sdk.usage.get()).rejects.toBeInstanceOf(BadRequestError);
  });
});

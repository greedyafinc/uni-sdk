import { describe, expect, test } from "bun:test";
import { parseRetryAfterHeader } from "../../src/core/_internal/retry";
import {
  AuthenticationError,
  BadRequestError,
  DeprecatedModelError,
  ForbiddenError,
  NotFoundError,
  RateLimitError,
  ServerError,
  StreamInterruptedError,
  UnifiedAI,
  UnifiedAIAuthError,
  UnifiedAIError,
  UnifiedError,
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

  test("410 + body code model_deprecated → DeprecatedModelError", () => {
    const e = buildHttpError("msg", 410, {
      status: "UNKNOWN",
      message: 'Model "gpt-3" is deprecated and is no longer available.',
      code: "model_deprecated",
    });
    expect(e).toBeInstanceOf(DeprecatedModelError);
    expect(e).toBeInstanceOf(UnifiedAIError);
    expect(e.code).toBe("model_deprecated");
    expect(e.status).toBe(410);
    expect((e as DeprecatedModelError).isDeprecated).toBe(true);
  });

  test("410 without the model_deprecated code stays generic (expired upload session)", () => {
    const e = buildHttpError("msg", 410, {
      status: "UNKNOWN",
      message: "Upload session abc has expired",
    });
    expect(e).not.toBeInstanceOf(DeprecatedModelError);
    expect(e).toBeInstanceOf(UnifiedAIError);
    expect(e.status).toBe(410);
  });

  test("model_deprecated body code is honored regardless of status", () => {
    const e = buildHttpError("msg", 400, { code: "model_deprecated", message: "gone" });
    expect(e).toBeInstanceOf(DeprecatedModelError);
    expect(e.code).toBe("model_deprecated");
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
    // Sibling, not subclass — generic retry wrappers that catch only
    // RateLimitError must not pick up quota-exhaustion errors.
    expect(e).not.toBeInstanceOf(RateLimitError);
    expect(e).toBeInstanceOf(UnifiedAIError);
    const u = e as UsageLimitError;
    expect(u.code).toBe("usage_limit_exceeded");
    expect(u.isUsageLimit).toBe(true);
    expect(u.periodCost).toBeCloseTo(1.2345, 4);
    expect(u.limit).toBeCloseTo(5.0, 2);
  });

  test("regex anchored on 'Window cost:' — leading $X/$Y pair is ignored", () => {
    const body = {
      message: "Usage limit exceeded. Plan tier $5 / $20. Window cost: $0.50 / $1.00",
    };
    const e = buildHttpError("msg", 429, body) as UsageLimitError;
    expect(e).toBeInstanceOf(UsageLimitError);
    expect(e.periodCost).toBeCloseTo(0.5, 2);
    expect(e.limit).toBeCloseTo(1.0, 2);
  });

  test("429 with bare `limit` field stays a RateLimitError (not UsageLimitError)", () => {
    // Future rate-limit body shape — `limit` as requests-per-window. Must
    // not get mis-classified as quota exhaustion.
    const body = { error: "rate_limited", limit: 60, window: "1m" };
    const e = buildHttpError("msg", 429, body, { "retry-after": "5" });
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e).not.toBeInstanceOf(UsageLimitError);
    expect((e as RateLimitError).retryAfter).toBe(5);
  });

  test("usage-limit-ish phrase in throttle message stays RateLimitError", () => {
    // The `/^usage limit exceeded/i` check is anchored to the start of
    // the string so unrelated mentions don't misroute.
    const body = { error: "rate_limited", message: "temporary usage limit on this endpoint" };
    const e = buildHttpError("msg", 429, body);
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e).not.toBeInstanceOf(UsageLimitError);
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

  test("whitespace-only retry-after → retryAfter undefined (not 0)", () => {
    // Number("   ") === 0, so without a trim guard a blank header would read
    // as "retry immediately" instead of "no hint".
    const e = buildHttpError("msg", 429, { error: "rate_limited" }, { "retry-after": "   " });
    expect(e).toBeInstanceOf(RateLimitError);
    expect((e as RateLimitError).retryAfter).toBeUndefined();
  });

  test("empty retry-after → retryAfter undefined", () => {
    const e = buildHttpError("msg", 429, { error: "rate_limited" }, { "retry-after": "" });
    expect((e as RateLimitError).retryAfter).toBeUndefined();
  });

  test("garbage retry-after → retryAfter undefined", () => {
    const e = buildHttpError("msg", 429, { error: "rate_limited" }, { "retry-after": "soon" });
    expect((e as RateLimitError).retryAfter).toBeUndefined();
  });

  test("RateLimitError.retryAfter (seconds) is consistent with the retry loop's parser (ms)", () => {
    // Numeric forms only: the HTTP-date form calls Date.now() in each parse,
    // so strict equality across two calls would be racy on a second boundary
    // (it has its own tolerance-based test above).
    for (const header of ["3", " 7 ", "0"]) {
      const res = new Response("", { status: 429, headers: { "retry-after": header } });
      const ms = parseRetryAfterHeader(res);
      const e = buildHttpError("msg", 429, { error: "rate_limited" }, { "retry-after": header });
      expect(ms).toBeDefined();
      expect((e as RateLimitError).retryAfter).toBe(Math.ceil((ms as number) / 1000));
    }
  });

  test("403 -> ForbiddenError with code forbidden", () => {
    const e = buildHttpError("msg", 403, {});
    expect(e).toBeInstanceOf(ForbiddenError);
    expect(e).toBeInstanceOf(UnifiedAIError);
    expect(e.name).toBe("ForbiddenError");
    expect(e.code).toBe("forbidden");
    expect(e.status).toBe(403);
  });
});

describe("Error.cause propagation", () => {
  test("UnifiedError accepts a cause and surfaces it", () => {
    const cause = new Error("root");
    const e = new UnifiedError("not_found", "wrapped", 404, cause);
    expect(e.cause).toBe(cause);
  });

  test("UnifiedError without a cause does not define one", () => {
    const e = new UnifiedError("not_found", "no cause");
    expect("cause" in e).toBe(false);
  });

  test("StreamInterruptedError carries its transport cause", () => {
    const cause = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    const e = new StreamInterruptedError(cause);
    expect(e.cause).toBe(cause);
    expect(e.code).toBe("stream_interrupted");
  });

  test("UnifiedAIAuthError threads cause through the subclass chain", () => {
    const cause = new Error("provider exploded");
    const e = new UnifiedAIAuthError(
      "auth_refresh_failed",
      "refresh failed",
      undefined,
      undefined,
      undefined,
      cause,
    );
    expect(e.cause).toBe(cause);
    expect(e).toBeInstanceOf(AuthenticationError);
    expect(e.status).toBe(401);
  });
});

describe("SDK error marker", () => {
  test("every error class carries isUnifiedSdkError for cross-bundle detection", () => {
    const errors = [
      new UnifiedError("not_found", "x"),
      new UnifiedAIError("request_failed", "x", 418, undefined),
      new StreamInterruptedError(),
      buildHttpError("msg", 400, {}),
      buildHttpError("msg", 401, {}),
      buildHttpError("msg", 403, {}),
      buildHttpError("msg", 404, {}),
      buildHttpError("msg", 429, { error: "rate_limited" }),
      buildHttpError("msg", 500, {}),
      new UnifiedAIAuthError("auth_refresh_failed", "x"),
    ];
    for (const e of errors) {
      expect(e.isUnifiedSdkError).toBe(true);
    }
  });
});

describe("fetch path throws typed errors", () => {
  test("persistent 401 surfaces as AuthenticationError (UnifiedAIAuthError is a subclass)", async () => {
    let call = 0;
    const fakeFetch = (async () => {
      call++;
      return new Response(JSON.stringify({ message: "invalid key" }), {
        status: 401,
        headers: { "x-request-id": "req_401" },
      });
    }) as unknown as typeof fetch;
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetch,
      token: "abc",
    });
    // The client retries once with a fresh token before surfacing the
    // failure. Whether the underlying class name is UnifiedAIAuthError
    // (still-401 after refresh) or AuthenticationError (initial 401 with
    // no refresh available), consumers branching on instanceof
    // AuthenticationError must catch both — UnifiedAIAuthError extends
    // AuthenticationError for that reason.
    try {
      await sdk.usage.get();
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AuthenticationError);
      expect(err).toBeInstanceOf(UnifiedAIError);
      expect((err as AuthenticationError).status).toBe(401);
      expect((err as AuthenticationError).requestId).toBe("req_401");
    }
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
      retry: false,
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
      retry: false,
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
      retry: false,
    });
    await expect(sdk.usage.get()).rejects.toBeInstanceOf(ServerError);
  });

  test("404 dispatched as NotFoundError", async () => {
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetchReturning(404, { message: "no such model" }),
      token: "abc",
      retry: false,
    });
    await expect(sdk.models.list()).rejects.toBeInstanceOf(NotFoundError);
  });

  test("400 dispatched as BadRequestError", async () => {
    const sdk = new UnifiedAI({
      apiUrl: "https://example.test",
      fetch: fakeFetchReturning(400, { message: "bad payload" }),
      token: "abc",
      retry: false,
    });
    await expect(sdk.usage.get()).rejects.toBeInstanceOf(BadRequestError);
  });
});

import { describe, expect, test } from "bun:test";
import { UnifiedAI, UnifiedError } from "../src/index";

describe("UnifiedAI", () => {
  test("can be instantiated with no arguments", () => {
    const sdk = new UnifiedAI();
    expect(sdk).toBeInstanceOf(UnifiedAI);
  });

  test("accepts options", () => {
    const sdk = new UnifiedAI({ appId: "app_test", apiUrl: "https://api.test" });
    expect(sdk).toBeInstanceOf(UnifiedAI);
  });
});

describe("UnifiedError", () => {
  test("carries a code and optional status", () => {
    const err = new UnifiedError("not_implemented", "nope", 501);
    expect(err.code).toBe("not_implemented");
    expect(err.status).toBe(501);
    expect(err).toBeInstanceOf(Error);
  });
});

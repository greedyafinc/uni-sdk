import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type IntegrationHarness, startIntegrationHarness } from "./helpers/sdk-client";

describe("integration: usage", () => {
  let h: IntegrationHarness;

  beforeEach(async () => {
    h = await startIntegrationHarness();
  });

  afterEach(async () => {
    if (h) {
      h.flush();
      await h.stop();
    }
  });

  test("returns current usage snapshot", async () => {
    h.cassette("usage/get");
    const res = await h.sdk.usage.get();
    expect(typeof res.plan.id).toBe("number");
    expect(typeof res.plan.name).toBe("string");
    expect(typeof res.period.input_tokens).toBe("number");
    expect(typeof res.period.output_tokens).toBe("number");
    expect(typeof res.daily.limit).toBe("number");
    expect(typeof res.credits.balance).toBe("number");
  });
});

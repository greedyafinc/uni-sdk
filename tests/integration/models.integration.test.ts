import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type IntegrationHarness, startIntegrationHarness } from "./helpers/sdk-client";

describe("integration: models", () => {
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

  test("lists models", async () => {
    h.cassette("models/list");
    const res = await h.sdk.models.list();
    expect(res.object).toBe("list");
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data.length).toBeGreaterThan(0);
    const first = res.data[0];
    expect(typeof first?.id).toBe("string");
    expect(typeof first?.name).toBe("string");
    expect(first?.object).toBe("model");
  });

  test("lists models with author include", async () => {
    h.cassette("models/list-include-author");
    const res = await h.sdk.models.list({ include: ["author"] });
    expect(res.data.length).toBeGreaterThan(0);
    expect(typeof res.data[0]?.model_author.name).toBe("string");
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TEST_MODELS } from "./helpers/models";
import { type IntegrationHarness, startIntegrationHarness } from "./helpers/sdk-client";

describe("integration: embeddings", () => {
  let h: IntegrationHarness;

  beforeEach(async () => {
    h = await startIntegrationHarness();
  });

  afterEach(async () => {
    h.flush();
    await h.stop();
  });

  test("creates an embedding for a string input", async () => {
    h.cassette("embeddings/basic-string");

    const res = await h.sdk.embeddings.create({
      model: TEST_MODELS.embedding,
      input: "hello world",
    });

    expect(res.object).toBe("list");
    expect(res.data).toHaveLength(1);
    expect(Array.isArray(res.data[0]?.embedding)).toBe(true);
    expect(res.usage.total_tokens).toBeGreaterThan(0);
  });

  test("creates embeddings for an array input", async () => {
    h.cassette("embeddings/array-input");

    const res = await h.sdk.embeddings.create({
      model: TEST_MODELS.embedding,
      input: ["alpha", "beta", "gamma"],
    });

    expect(res.data).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(res.data[i]?.index).toBe(i);
      expect(Array.isArray(res.data[i]?.embedding)).toBe(true);
    }
  });
});

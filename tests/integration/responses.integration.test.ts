import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TEST_MODELS } from "./helpers/models";
import { type IntegrationHarness, startIntegrationHarness } from "./helpers/sdk-client";

describe("integration: responses", () => {
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

  test("creates a non-streaming response", async () => {
    h.cassette("responses/basic");

    const res = await h.sdk.responses.create({
      model: TEST_MODELS.text,
      input: "Say hi",
      max_output_tokens: 16,
    });

    expect(res.object).toBe("response");
    expect(typeof res.id).toBe("string");
    expect(Array.isArray(res.output)).toBe(true);
    expect(res.usage.total_tokens).toBeGreaterThan(0);
  });

  test("streams response events", async () => {
    h.cassette("responses/stream");

    const stream = h.sdk.responses.create({
      model: TEST_MODELS.text,
      input: "Say hi",
      max_output_tokens: 16,
      stream: true,
    });

    let eventCount = 0;
    let sawCompleted = false;
    for await (const event of stream) {
      eventCount++;
      if (event.type === "response.completed") sawCompleted = true;
    }
    expect(eventCount).toBeGreaterThan(0);
    expect(sawCompleted).toBe(true);
  });
});

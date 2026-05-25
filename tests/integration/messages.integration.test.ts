import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TEST_MODELS } from "./helpers/models";
import { type IntegrationHarness, startIntegrationHarness } from "./helpers/sdk-client";

describe("integration: messages", () => {
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

  test("creates a non-streaming message", async () => {
    h.cassette("messages/basic");

    const res = await h.sdk.messages.create({
      model: TEST_MODELS.messages,
      messages: [{ role: "user", content: "Say hi" }],
      max_tokens: 16,
    });

    expect(res.type).toBe("message");
    expect(res.role).toBe("assistant");
    expect(Array.isArray(res.content)).toBe(true);
    expect(typeof res.usage.input_tokens).toBe("number");
    expect(typeof res.usage.output_tokens).toBe("number");
  }, 30_000);

  test("aggregates a streaming message via finalMessage()", async () => {
    h.cassette("messages/stream");

    const stream = h.sdk.messages.create({
      model: TEST_MODELS.messages,
      messages: [{ role: "user", content: "Say hi" }],
      max_tokens: 16,
      stream: true,
    });

    const final = await stream.finalMessage();
    expect(final.type).toBe("message");
    expect(final.role).toBe("assistant");
    expect(final.content.length).toBeGreaterThan(0);
    const firstBlock = final.content[0];
    expect(firstBlock?.type).toBe("text");
    if (firstBlock?.type === "text") {
      expect(firstBlock.text.length).toBeGreaterThan(0);
    }
    expect(typeof final.usage.input_tokens).toBe("number");
    expect(typeof final.usage.output_tokens).toBe("number");
  }, 30_000);

  test("returns a tool_use block for forced tool call", async () => {
    h.cassette("messages/tool-use");

    const res = await h.sdk.messages.create({
      model: TEST_MODELS.messages,
      messages: [{ role: "user", content: "What's the weather in Paris?" }],
      max_tokens: 256,
      tools: [
        {
          name: "get_weather",
          description: "Get the current weather for a location.",
          input_schema: {
            type: "object",
            properties: { location: { type: "string" } },
            required: ["location"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "get_weather" },
    });

    expect(res.stop_reason).toBe("tool_use");
    const toolBlock = res.content.find((b) => b.type === "tool_use");
    expect(toolBlock).toBeDefined();
    if (toolBlock?.type === "tool_use") {
      expect(toolBlock.name).toBe("get_weather");
      expect(typeof toolBlock.input).toBe("object");
    }
  }, 30_000);
});

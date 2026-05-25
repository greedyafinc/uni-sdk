import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TEST_MODELS } from "./helpers/models";
import { type IntegrationHarness, startIntegrationHarness } from "./helpers/sdk-client";

describe("integration: chat.completions", () => {
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

  test("creates a non-streaming completion", async () => {
    h.cassette("chat/basic");

    const res = await h.sdk.chat.completions.create({
      model: TEST_MODELS.text,
      messages: [{ role: "user", content: "Say hi" }],
      max_tokens: 16,
    });

    expect(res.object).toBe("chat.completion");
    expect(res.choices).toHaveLength(1);
    expect(res.choices[0]?.message.role).toBe("assistant");
    expect(typeof res.choices[0]?.message.content).toBe("string");
  });

  test("streams a completion and exposes usage", async () => {
    h.cassette("chat/stream");

    const stream = h.sdk.chat.completions.create({
      model: TEST_MODELS.text,
      messages: [{ role: "user", content: "Say hi" }],
      max_tokens: 16,
      stream: true,
      stream_options: { include_usage: true },
    });

    let assembled = "";
    let chunkCount = 0;
    for await (const chunk of stream) {
      chunkCount++;
      const delta = chunk.choices?.[0]?.delta?.content;
      if (typeof delta === "string") assembled += delta;
    }
    expect(chunkCount).toBeGreaterThan(0);
    expect(assembled.length).toBeGreaterThan(0);
  }, 30_000);

  test("returns tool_calls when a function tool is forced", async () => {
    h.cassette("chat/tool-use");

    const res = await h.sdk.chat.completions.create({
      model: TEST_MODELS.messages,
      messages: [{ role: "user", content: "What's the weather in Paris?" }],
      max_tokens: 256,
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get the current weather for a location.",
            parameters: {
              type: "object",
              properties: { location: { type: "string" } },
              required: ["location"],
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "get_weather" } },
    });

    const choice = res.choices[0];
    expect(choice).toBeDefined();
    const toolCalls = choice?.message.tool_calls;
    expect(Array.isArray(toolCalls)).toBe(true);
    expect(toolCalls?.length ?? 0).toBeGreaterThan(0);
    expect(toolCalls?.[0]?.function.name).toBe("get_weather");
    expect(typeof toolCalls?.[0]?.function.arguments).toBe("string");
  }, 30_000);
});

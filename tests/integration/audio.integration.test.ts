import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type IntegrationHarness, startIntegrationHarness } from "./helpers/sdk-client";

describe("integration: audio", () => {
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

  test("synthesizes speech and returns binary audio bytes", async () => {
    h.cassette("audio/speech");

    const res = await h.sdk.audio.speech({
      model: "hexgrad/Kokoro-82M",
      input: "Hello, world.",
      voice: "af_bella",
      response_format: "mp3",
    });

    expect(res.contentType.startsWith("audio/")).toBe(true);
    expect(res.audio).toBeInstanceOf(ArrayBuffer);
    expect(res.audio.byteLength).toBeGreaterThan(0);
  }, 60_000);
});

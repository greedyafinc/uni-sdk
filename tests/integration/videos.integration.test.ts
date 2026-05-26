import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type IntegrationHarness, startIntegrationHarness } from "./helpers/sdk-client";

describe("integration: videos", () => {
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

  test("creates, polls to completion, and downloads the rendered bytes", async () => {
    h.cassette("videos/lifecycle");

    const created = await h.sdk.videos.create({
      prompt: "a small red square spinning",
      model: "veo-3.1-lite-generate-001",
      seconds: "4",
      size: "1280x720",
    });
    expect(created.status).toBe("queued");
    expect(created.id).toContain("/operations/");

    const ready = await h.sdk.videos.waitUntilReady(created.id, {
      pollIntervalMs: 1,
      timeoutMs: 5_000,
    });
    expect(ready.status).toBe("completed");

    const content = await h.sdk.videos.content(created.id);
    expect(content.mimeType.startsWith("video/")).toBe(true);
    expect(content.bytes.byteLength).toBeGreaterThan(0);
    // Verify the mp4 magic bytes ("ftyp" at offset 4) survive the binary
    // round-trip through the cassette base64 layer.
    const view = new Uint8Array(content.bytes);
    const magic = new TextDecoder().decode(view.subarray(4, 8));
    expect(magic).toBe("ftyp");
  }, 30_000);
});

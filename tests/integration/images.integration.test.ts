import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { TEST_MODELS } from "./helpers/models";
import { type IntegrationHarness, startIntegrationHarness } from "./helpers/sdk-client";

describe("integration: images", () => {
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

  test("generates an image", async () => {
    h.cassette("images/generate");

    const res = await h.sdk.images.generate({
      model: TEST_MODELS.image,
      prompt: "a small red square",
      n: 1,
      size: "1024x1024",
    });

    expect(typeof res.created).toBe("number");
    expect(res.data).toBeDefined();
    expect(res.data?.length ?? 0).toBeGreaterThanOrEqual(1);
    const first = res.data?.[0];
    expect(first).toBeDefined();
    // Either base64 payload or signed URL must be present.
    expect(Boolean(first?.b64_json) || Boolean(first?.signed_url) || Boolean(first?.url)).toBe(
      true,
    );
  }, 60_000);

  test("edits an image referenced by URL", async () => {
    h.cassette("images/edit");

    const edited = await h.sdk.images.edit({
      model: TEST_MODELS.imageEdit,
      images: [
        {
          image_url: "https://picsum.photos/seed/uni-sdk-test/256.jpg",
        },
      ],
      prompt: "make it blue",
      n: 1,
    });

    expect(edited.data).toBeDefined();
    expect(edited.data?.length ?? 0).toBeGreaterThanOrEqual(1);
    const first = edited.data?.[0];
    expect(Boolean(first?.b64_json) || Boolean(first?.signed_url) || Boolean(first?.url)).toBe(
      true,
    );
  }, 120_000);
});

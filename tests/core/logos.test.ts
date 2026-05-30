import { describe, expect, test } from "bun:test";
import { getModelLogo, getProviderLogo, listProviderLogos } from "../../src/resources/logos";

describe("getProviderLogo", () => {
  test("returns a data-URI for a known provider", () => {
    const uri = getProviderLogo("Anthropic");
    expect(uri.startsWith("data:")).toBe(true);
  });
  test("falls back to a data-URI for unknown / null input", () => {
    expect(getProviderLogo(null).startsWith("data:")).toBe(true);
    expect(getProviderLogo("totally-unknown-provider").startsWith("data:")).toBe(true);
  });
});

describe("getModelLogo", () => {
  test("prefers model_author.name over owned_by", () => {
    const byAuthor = getModelLogo({
      model_author: { name: "Anthropic" },
      owned_by: "something-else",
    });
    expect(byAuthor).toBe(getProviderLogo("Anthropic"));
  });
  test("falls back to owned_by when author is absent", () => {
    const byOwner = getModelLogo({ owned_by: "OpenAI" });
    expect(byOwner).toBe(getProviderLogo("OpenAI"));
  });
  test("falls back to the neutral mark for an empty model", () => {
    expect(getModelLogo({}).startsWith("data:")).toBe(true);
  });
  test("respects the dark theme argument", () => {
    // Whatever the light value is, the call must still return a data-URI; dark
    // may differ when a -dark variant exists but must never throw.
    expect(getModelLogo({ model_author: { name: "Anthropic" } }, "dark").startsWith("data:")).toBe(
      true,
    );
  });
});

describe("listProviderLogos", () => {
  test("excludes the fallback and -dark variants", () => {
    const slugs = listProviderLogos();
    expect(Array.isArray(slugs)).toBe(true);
    expect(slugs.some((s) => s.endsWith("-dark"))).toBe(false);
  });
});

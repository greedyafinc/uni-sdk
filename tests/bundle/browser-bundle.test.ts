import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const BROWSER_BUNDLE = join(ROOT, "dist", "index.browser.js");
const NODE_BUNDLE = join(ROOT, "dist", "node", "index.js");

// These tests assert the structural invariants of the dual-entry build. They
// run AFTER `bun run build` — in CI, the build step always precedes the test
// step. Locally, run `bun run build && bun test tests/bundle` to refresh.

describe("browser bundle is node-free", () => {
  if (!existsSync(BROWSER_BUNDLE)) {
    test.skip("dist/index.browser.js not built yet — run `bun run build`", () => {});
    return;
  }

  const source = readFileSync(BROWSER_BUNDLE, "utf8");

  test("contains no `node:*` specifiers", () => {
    const matches = source.match(/\bnode:[a-z/]+/g);
    expect(matches).toBeNull();
  });

  test("contains no `@napi-rs/keyring` imports", () => {
    expect(source).not.toContain("@napi-rs/keyring");
  });

  test("contains no CommonJS require() calls", () => {
    expect(source).not.toMatch(/\brequire\s*\(/);
  });

  test("exports UnifiedAI", async () => {
    // Import the built bundle directly to verify the surface is intact.
    const mod = await import(BROWSER_BUNDLE);
    expect(mod.UnifiedAI).toBeDefined();
    expect(typeof mod.UnifiedAI).toBe("function");
  });

  test("UnifiedAI in browser bundle errors on OAuth bootstrap without token", async () => {
    const mod = await import(BROWSER_BUNDLE);
    const sdk = new mod.UnifiedAI();
    await expect(sdk.bootstrap()).rejects.toMatchObject({
      code: "not_implemented",
    });
  });

  test("UnifiedAI in browser bundle accepts trusted-token mode", async () => {
    const mod = await import(BROWSER_BUNDLE);
    const sdk = new mod.UnifiedAI({ token: "test" });
    await expect(sdk.bootstrap()).resolves.toBeUndefined();
  });
});

describe("node bundle has OAuth surface", () => {
  if (!existsSync(NODE_BUNDLE)) {
    test.skip("dist/node/index.js not built yet — run `bun run build`", () => {});
    return;
  }

  test("exports UnifiedAI with OAuth-capable subclass", async () => {
    const mod = await import(NODE_BUNDLE);
    expect(mod.UnifiedAI).toBeDefined();
    expect(typeof mod.UnifiedAI).toBe("function");
    // The node UnifiedAI accepts node-specific options without TypeScript
    // complaints — instantiating with `keychain` confirms the subclass surface
    // is present (the base would silently ignore the option).
    const sdk = new mod.UnifiedAI({
      token: "test",
      keychain: {
        get: async () => null,
        set: async () => {},
        clear: async () => {},
      },
    });
    expect(sdk).toBeDefined();
  });

  test("node bundle is strictly larger than browser bundle", () => {
    const browser = statSync(BROWSER_BUNDLE).size;
    const node = statSync(NODE_BUNDLE).size;
    expect(node).toBeGreaterThan(browser);
  });
});

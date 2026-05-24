#!/usr/bin/env bun
/**
 * Asserts that the browser bundle is free of Node-only dependencies.
 *
 * Runs as part of `bun run build` and as a standalone CI step. The structural
 * invariant — "the browser entry must never pull `node:*` or `@napi-rs/keyring`"
 * — is enforced here so it can't silently regress when someone adds a new
 * static import to a module the browser entry transitively reaches.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BUNDLE = join(ROOT, "dist", "index.browser.js");

if (!existsSync(BUNDLE)) {
  console.error(`❌ Browser bundle not found at ${BUNDLE}`);
  console.error("   Run `bun run build:browser` first.");
  process.exit(1);
}

const source = readFileSync(BUNDLE, "utf8");

interface Check {
  pattern: RegExp;
  name: string;
  hint?: string;
}

const FORBIDDEN: Check[] = [
  {
    pattern: /\bnode:[a-z/]+/g,
    name: "node: specifier",
    hint:
      "A Node built-in module is statically imported. Move the consumer into src/node/ " +
      "or import it dynamically from a node-only path.",
  },
  {
    pattern: /@napi-rs\/keyring/g,
    name: "@napi-rs/keyring import",
    hint:
      "The native keychain module leaked into the browser bundle. Ensure keychain.ts " +
      "is only reachable from src/node/.",
  },
  {
    pattern: /\brequire\s*\(/g,
    name: "CommonJS require",
    hint: "The browser bundle should be pure ESM. Check the build target.",
  },
];

const failures: Array<{ check: Check; matches: string[] }> = [];
for (const check of FORBIDDEN) {
  const matches = source.match(check.pattern);
  if (matches?.length) {
    failures.push({ check, matches: [...new Set(matches)] });
  }
}

if (failures.length > 0) {
  console.error("❌ Browser bundle contains forbidden imports:\n");
  for (const { check, matches } of failures) {
    console.error(`  • ${check.name} (${matches.length} unique)`);
    for (const m of matches.slice(0, 8)) {
      console.error(`      ${m}`);
    }
    if (matches.length > 8) {
      console.error(`      … and ${matches.length - 8} more`);
    }
    if (check.hint) {
      console.error(`    Hint: ${check.hint}`);
    }
    console.error("");
  }
  process.exit(1);
}

const sizeKb = (source.length / 1024).toFixed(1);
console.log(`✅ Browser bundle is clean (${sizeKb} KB)`);

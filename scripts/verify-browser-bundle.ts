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

// Every bundle that must stay browser-safe. dist/app/index.js is the embedded-
// app kernel — it feeds `search.js` chunks that load inside the desktop shell's
// webview, so a Node built-in there is just as fatal as in the main entry.
const BUNDLES = [
  { path: join(ROOT, "dist", "index.browser.js"), build: "bun run build:browser" },
  { path: join(ROOT, "dist", "app", "index.js"), build: "bun run build:app" },
];

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

let failed = false;
for (const bundle of BUNDLES) {
  if (!existsSync(bundle.path)) {
    console.error(`❌ Browser bundle not found at ${bundle.path}`);
    console.error(`   Run \`${bundle.build}\` first.`);
    process.exit(1);
  }
  const source = readFileSync(bundle.path, "utf8");

  const failures: Array<{ check: Check; matches: string[] }> = [];
  for (const check of FORBIDDEN) {
    const matches = source.match(check.pattern);
    if (matches?.length) {
      failures.push({ check, matches: [...new Set(matches)] });
    }
  }

  if (failures.length > 0) {
    failed = true;
    console.error(`❌ ${bundle.path} contains forbidden imports:\n`);
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
    continue;
  }

  const sizeKb = (source.length / 1024).toFixed(1);
  console.log(`✅ ${bundle.path} is clean (${sizeKb} KB)`);
}

if (failed) process.exit(1);

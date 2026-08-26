#!/usr/bin/env bun
/**
 * `prepare` runs on `bun install` for this checkout and — if the consumer
 * trusts us — for `github:` / `file:` installs too.
 *
 * Bun does not run lifecycle scripts for git dependencies by default. Even
 * when trusted, a rebuild here would `rm -rf dist` and then fail: `tsc` needs
 * `typescript` and `@types/*`, which bun does not install for dependencies.
 *
 * `dist/` JS + `.d.ts` are committed so a default (untrusted) GitHub install
 * already has every `exports` target. Skip the rebuild when we are inside
 * someone else's `node_modules` and that committed output is present. In this
 * repo's own checkout, still build so local/CI `bun install` refreshes dist.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

const root = join(import.meta.dir, "..");
const hasDist = existsSync(join(root, "dist", "index.browser.js"));
const installedAsDependency = /[/\\]node_modules[/\\]/.test(root);

if (installedAsDependency && hasDist) {
  console.log("@unifiedai/sdk: using committed dist/ (skipping prepare rebuild)");
  process.exit(0);
}

if (installedAsDependency && !hasDist) {
  console.error(
    "@unifiedai/sdk: dist/ is missing and this install cannot rebuild it. " +
      "Use a revision that commits dist/ (JS + .d.ts), or clone the repo and run `bun run build`.",
  );
  process.exit(1);
}

await $`bun run build`;

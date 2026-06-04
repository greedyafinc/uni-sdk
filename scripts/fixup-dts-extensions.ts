// Post-build step: make the emitted .d.ts NodeNext-consumable.
//
// We compile declarations with `moduleResolution: bundler` (tsconfig.json),
// which emits EXTENSIONLESS relative specifiers, e.g.
//     export * from "./resources/chat";
//     import { UnifiedStream } from "../core/_internal/stream";
//
// Consumers that resolve with `moduleResolution: node16/nodenext` (the default
// for a modern Node ESM app — e.g. the Open Design daemon) REQUIRE explicit
// `.js` extensions on relative specifiers. Without them every re-export silently
// fails to resolve and the package's whole type surface collapses to `any`
// (masked by the consumer's `skipLibCheck`).
//
// This script rewrites relative `from "..."` / `import("...")` specifiers in the
// built declarations to add a `.js` extension. The result resolves under BOTH
// bundler and NodeNext, so every consumer is covered. The runtime JS bundles are
// single flat files with no relative imports, so only `.d.ts` need this.

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DIST = join(import.meta.dir, "..", "dist");

// Relative specifier inside `from "..."` or `import("...")`. We only touch
// specifiers that start with `.` and don't already carry a `.js`/`.json`
// extension. Note `./resources/logos.generated` -> `.generated` is part of the
// filename, not an extension, so it correctly becomes `.generated.js`.
const SPECIFIER = /(\bfrom\s*"|\bimport\s*\(\s*")(\.\.?\/[^"]*?)(")/g;

function needsExtension(spec: string): boolean {
  return !/\.(js|json)$/.test(spec);
}

function rewrite(source: string): string {
  return source.replace(SPECIFIER, (match, head: string, spec: string, tail: string) =>
    needsExtension(spec) ? `${head}${spec}.js${tail}` : match,
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

let patched = 0;
for (const file of walk(DIST)) {
  const before = readFileSync(file, "utf8");
  const after = rewrite(before);
  if (after !== before) {
    writeFileSync(file, after);
    patched += 1;
  }
}
console.log(
  `[fixup-dts] added .js extensions to relative specifiers in ${patched} declaration file(s)`,
);

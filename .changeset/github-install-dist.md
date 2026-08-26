---
"@unifiedai/sdk": patch
---

GitHub installs (`github:greedyafinc/uni-sdk#…`) now resolve `.`, `./app`,
`./logos`, and the other documented subpaths on a default `bun install`.
`dist/` JS and `.d.ts` are committed; `prepare` no longer rebuilds (and
no longer fails) when the package is installed into `node_modules`.
Consumers do not need `trustedDependencies` or `bun install --trust`.

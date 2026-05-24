---
"@unifiedai/sdk": minor
---

Split SDK into two entry points so the same package works in browsers,
Workers/edge runtimes, and Node without forcing consumers to bundle Node-only
modules.

- **Default `@unifiedai/sdk`** — browser-safe; contains zero `node:*`
  specifiers and no native dependencies. Trusted-token mode only (pass `token`
  as a string or async function). Vite, Webpack, Rollup, and esbuild bundle
  it without polyfills.
- **`@unifiedai/sdk/node`** — strict superset; same class name, plus the
  OAuth Authorization Code + PKCE flow with local loopback HTTP listener,
  OS keychain storage, and discovery-file handoff.

Bundlers auto-resolve via the `browser` and `node` export conditions in
`package.json` — most consumers don't need to change any imports.

If you were using OAuth from the default import, switch to the `/node`
subpath. See [MIGRATION.md](./MIGRATION.md) for details.

Additional changes shipped together:

- `UnifiedAIError.message` now appends the server-extracted error message
  when the body matches a known shape (`{message}`, `{error}`,
  `{error.message}`, FastAPI `{detail}`, `{errors[]}`). The full body is
  still on `err.body`. All extracted strings are capped to 400 characters
  to prevent runaway server payloads from flooding `Error.message`.
- Trusted-token refresh on 401 now coalesces concurrent provider invocations
  (single-flight). A host whose `token` callback does real I/O sees one
  refresh per 401 burst instead of N.
- A structural-invariant CI check (`scripts/verify-browser-bundle.ts` plus
  `tests/bundle/browser-bundle.test.ts`) fails the build if the browser
  bundle ever picks up a `node:*` specifier or `@napi-rs/keyring` import.

---
"@unifiedai/sdk": minor
---

Embedded UnifiedApp apps are now a first-class SDK surface, with new subpath
entries, docs, and a starter template:

- **`@unifiedai/sdk/app`** — the dependency-free kernel embedded apps used to
  copy per app: action helpers (`safeRegisterActions`,
  `makeOpenArtifactAdapter`, `requiredParam`/`notFound`/`storageUnavailable`),
  the search-provider kernel (`scoreFields`, `matchKind`, `isHinted`,
  `HINTS_FLOOR`, `queryBySearchText`, `createLatchedFallback`, `toSearchHit`,
  `compareHits`), text chores (`escapeHtml`, `truncateOnWord`,
  `clampWithEllipsis`, `PREVIEW_MAX`, `SEARCH_TEXT_MAX`), the protocol
  constants (`HOST_LIMITS`, `SEARCH_PROTOCOL_VERSION`), and the re-exported
  search contract types (`SearchProvider`, `SearchRequest`, `SearchHit`,
  `SearchProviderContext` — now with optional `limits`/`protocolVersion` a
  host can push at runtime).
- **`@unifiedai/sdk/app/testkit`** — `findHitViolations` (host-contract
  validator) and `benchmark`/`formatBench`, framework-agnostic so they run
  under bun:test and vitest alike.
- **`@unifiedai/sdk/app/dev-host-api`** — the standalone-dev shim for the
  `@unified/host-api` bridge (env: `VITE_DEV_API_KEY`,
  `VITE_UNIFIED_APP_ID`).
- **`@unifiedai/sdk/app/vite`** — `unifiedApp({ appId })`, the Vite plugin
  that externalizes `@unified/host-api` to `/host-api.js` in build and
  aliases it to the dev shim in serve.
- **`@unifiedai/sdk/host-api`** + **`/host-api/ambient`** — the host-bridge
  types, with an ambient `declare module "@unified/host-api"` for tsconfig
  `"types"`.

New docs: `APP_GUIDE.md` (the app-author tutorial), a normative
**PROTOCOL.md § Embedded apps** section (manifest schema, `<appId>__<actionId>`
wire names, the search provider load contract, host limits under
`SEARCH_PROTOCOL_VERSION` 1, hit sanitization), and a runnable
`templates/app-template` (Vue 3 + Vite, shipped in the npm package).

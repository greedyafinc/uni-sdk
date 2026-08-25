# UnifiedApp embedded-app template

A minimal Vue 3 + Vite embedded app for the UnifiedApp marketplace, showing the
whole path: a manifest with actions and a search entry, module-scope action
registration (including the ecosystem-standard `openArtifact` verb), a
cross-app search provider built on the `@unifiedai/sdk/app` kernel, and
contract tests on the `@unifiedai/sdk/app/testkit`.

Read [APP_GUIDE.md](../../APP_GUIDE.md) for the tutorial and
[PROTOCOL.md § Embedded apps](../../PROTOCOL.md#embedded-apps) for the
normative host contract. To start your own app, copy this directory and change
`my-app` (in `public/manifest.json`, `vite.config.ts`, `src/entry.ts`,
`src/search.ts`, and the tests) to your app id.

## Layout

```
public/manifest.json   id/actions/search declaration the host reads
src/entry.ts           app.js entry — registers action handlers, exports the UI
src/App.vue            tiny list UI over the in-memory store
src/store.ts           seeded items (Vue-free — the search chunk imports it)
src/search.ts          search.js entry — exports createSearchProvider
tests/                 contract + budget tests (bun:test; testkit is framework-agnostic)
```

## Develop

```bash
bun install
cp .env.example .env 2>/dev/null; echo "VITE_DEV_API_KEY=uapi_..." >> .env  # your dev key
bun run dev
```

Standalone dev runs outside the shell: the `unifiedApp()` Vite plugin aliases
`@unified/host-api` to the SDK's dev shim, which builds a real `UnifiedAI`
against the `/api/v1` dev proxy (see `vite.config.ts`). `registerActions` is a
no-op there — actions and search fan-out only exist inside the host.

## Build

```bash
bun run build
```

Emits `dist/app.js`, `dist/search.js`, and `dist/manifest.json` (copied from
`public/`). `@unified/host-api` stays external (rewritten to `/host-api.js`,
served by the host); everything else, Vue included, is bundled.

## Test

```bash
bun test
```

`tests/search.contract.test.ts` validates every hit against the host contract
(`findHitViolations`) and asserts the provider sits far under the per-provider
time budget (`benchmark`).

# @unifiedai/sdk

Official SDK for Unifiedai marketplace apps. Browser + Tauri WebView only —
no Node.js-specific APIs in the published bundle.

This repo is currently a clean scaffold: tooling, build, CI, and release are
all wired up, but no resources are implemented yet.

## Install

```sh
bun add @unifiedai/sdk
```

## Usage

```ts
import { UnifiedAI } from "@unifiedai/sdk";

const sdk = new UnifiedAI();
// In production, the Unifiedai shell injects credentials before your app loads.
// For local dev: new UnifiedAI({ token, apiUrl, workspaceId, appId })
```

Resources will be attached as instance properties (`sdk.messages`,
`sdk.events`, …) as they're built.

## Project layout

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full breakdown and the
convention for adding a resource.

## Development

```sh
bun install
bun run lint        # biome
bun run typecheck   # tsc --noEmit
bun test            # bun test
bun run build       # bun build (ESM, browser target) + tsc declarations
bun run docs        # typedoc → ./docs
```

## Releasing

Releases are driven by [Changesets](https://github.com/changesets/changesets).
A PR with a `.changeset/*.md` file lands on `main`; the release workflow
opens a "Version Packages" PR; merging that PR publishes to npm.

Requires the `NPM_TOKEN` repo secret.

## License

MIT

# Building an embedded UnifiedApp app

The practical guide to writing a third-party **embedded app** for the UnifiedApp
marketplace with `@unifiedai/sdk`. The normative wire contract lives in
[PROTOCOL.md § Embedded apps](PROTOCOL.md#embedded-apps); this document is the
tutorial. A runnable starting point is in
[`templates/app-template`](templates/app-template/README.md).

## What an embedded app is

An embedded app is a **web bundle** the UnifiedApp desktop shell loads
in-process: a `manifest.json` plus an ES-module `app.js` (your UI) and,
optionally, a separate `search.js` (your cross-app search provider). The host:

- imports `app.js` and mounts your exported component when the user opens the app;
- invokes the **actions** you declared in the manifest and registered at runtime
  (from its chat agent loop, from cross-app pointers, and — if you opt in — over
  MCP);
- lazily imports `search.js` when the user searches across apps.

Your app talks back to the host through **one bare specifier**,
`@unified/host-api` — the host bridge. It gives you an authenticated SDK
instance (`getSdk()`), theming (`getTheme`/`onThemeChange`), action registration
(`registerActions`), and the agent bridge (`runAgent` et al.). The specifier is
**externalized** at build time (the host serves the real implementation), and
**aliased to a dev shim** when you run standalone — you never bundle it.

Who owns what:

- **Host-owned:** loading, sandboxing/attribution, action routing + consent,
  search fan-out, hit sanitization, timeouts. You cannot widen these from app code.
- **SDK-owned:** the helper kernel (`@unifiedai/sdk/app`), the bridge types, the
  Vite plugin, the testkit — shared by first-party and third-party apps alike.
- **App-owned:** your UI, your data model, your action handlers, your scoring
  choices inside the provider contract.

## Project setup

```bash
bun add vue @unifiedai/sdk@github:greedyafinc/uni-sdk#main
bun add -d vite @vitejs/plugin-vue typescript vue-tsc
```

The SDK is not on npm. A default `bun install` of the GitHub repo is enough
for `@unifiedai/sdk/app` and the other subpaths — `dist/` is committed, so
do not add `trustedDependencies` or pass `--trust`. Pin a commit SHA in CI.

`vite.config.ts` — the `unifiedApp()` plugin wires `@unified/host-api` for both
modes (externalized + rewritten to `/host-api.js` in build; aliased to the dev
shim in serve), and lib mode emits the two entries the manifest names:

```ts
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { unifiedApp } from "@unifiedai/sdk/app/vite";

export default defineConfig({
  plugins: [vue(), unifiedApp({ appId: "my-app" })],
  build: {
    lib: {
      entry: { app: "src/entry.ts", search: "src/search.ts" },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
  },
});
```

`tsconfig.json` — pull in the ambient declaration for `@unified/host-api` so
the bare specifier typechecks without resolving:

```jsonc
{
  "compilerOptions": {
    "types": ["@unifiedai/sdk/host-api/ambient"]
  }
}
```

(If you prefer, a `/// <reference types="@unifiedai/sdk/host-api/ambient" />`
in any `.d.ts` of your app does the same.)

## The manifest

`public/manifest.json` is copied verbatim into your bundle. A trimmed, annotated
example (see the docs app for a fuller one):

```jsonc
{
  "id": "my-app",          // your unique app id — also the action wire-name prefix
  "name": "My App",
  "version": "0.1.0",
  "icon": "file",
  "kind": "web",
  "module": "app.js",      // what the host imports to mount you
  "search": {
    "entry": "search.js",  // separate chunk; host imports it lazily
    "kinds": ["item"]      // lowercase kinds your provider returns
  },
  "actions": [
    {
      "id": "openItem",
      "title": "Open an item",
      "description": "Open an existing item so the user sees it. Params: itemId (required) — an id from a search hit; never invent ids.",
      "params": {
        "type": "object",
        "properties": { "itemId": { "type": "string", "description": "The id of the item to open." } },
        "required": ["itemId"],
        "additionalProperties": false
      },
      "tier": "safe",
      "mutates": false,    // EXPLICIT. mutates defaults to true (fail-closed) —
      "surfaces": true     // an action without `mutates: false` can never be
    },                     // invoked from a search hit's openRef.action
    { /* openArtifact — copied VERBATIM from OPEN_ARTIFACT_SPEC, see below */ }
  ]
}
```

Rules that bite:

- Action ids match `/^[a-zA-Z0-9-]+$/` — no `__`. The wire name callers see is
  `<appId>__<actionId>` (`my-app__openItem`).
- `mutates` **defaults to `true`**. Declare `mutates: false` on every genuinely
  read-only action, or read-only paths (like search-hit opening) will refuse it.
- `description` is read by an LLM. Say where valid ids come from — a model told
  only "not found" will guess another id.
- Every app that can surface an artifact declares **`openArtifact`** copied
  verbatim from `OPEN_ARTIFACT_SPEC` (exported by `@unifiedai/sdk`) — hosts may
  assert deep equality against it.

## Registering actions (`src/entry.ts`)

The module `manifest.module` names must register handlers for the declared
actions **at module scope** (the host may warm-load your bundle and invoke
immediately, without mounting the UI), and default-export your root component:

```ts
import App from "./App.vue";
import { registerActions } from "@unified/host-api";
import {
  safeRegisterActions,
  makeOpenArtifactAdapter,
  requiredParam,
  notFound,
  storageUnavailable,
} from "@unifiedai/sdk/app";
import { getItem, openItem } from "./store";

safeRegisterActions("my-app", () => {
  registerActions({
    async openItem(params) {
      const { itemId } = params as { itemId?: string };
      if (!itemId) throw new Error(requiredParam("itemId", "ids come from a search hit."));
      const item = getItem(itemId);
      if (!item) throw new Error(notFound("Item", itemId, "Ids come from a My App search hit."));
      openItem(itemId);
      return { ok: true };
    },
    // The ecosystem-standard open verb: adapt the platform's ArtifactRef shape
    // onto your own open action. Search hits, @-mentions, project links and
    // references all arrive here.
    openArtifact: makeOpenArtifactAdapter(({ objectId }) => {
      if (!getItem(objectId)) {
        throw new Error(notFound("Item", objectId, "Ids come from a My App search hit."));
      }
      openItem(objectId);
      return { kind: "item" as const };
    }),
  });
});

export default App;
```

What the helpers buy you:

- `safeRegisterActions(name, thunk)` swallows the two failures that are not
  bugs — standalone dev (the shim's `registerActions` is a no-op) and a host too
  old to expose registration — instead of taking your whole module load down.
- `makeOpenArtifactAdapter(open)` normalizes the incoming params
  (`objectId` → `""` when absent, `fragment`/`kind`/`collection` passed through)
  so your own open action stays the single owner of validation and error text.
- `requiredParam` / `notFound` / `storageUnavailable` produce the error-message
  family the ecosystem's models are tuned to: a short declarative sentence, then
  the thing the caller should do about it. Throw them as plain `Error`s — the
  host wraps them as `E_APP_ERROR`.

## Writing a search provider (`src/search.ts`)

`search.js` is a **separate chunk** the host imports without your UI. Keep it
free of Vue and your component tree — import only your data layer and the
dependency-free kernel from `@unifiedai/sdk/app`. Export `createSearchProvider`
(named or default):

```ts
import type { CreateSearchProvider, SearchHit, SearchRequest } from "@unifiedai/sdk/app";
import {
  scoreFields,
  isHinted,
  HINTS_FLOOR,
  toSearchHit,
  compareHits,
  HOST_LIMITS,
} from "@unifiedai/sdk/app";
import { listItems } from "./store";

export const createSearchProvider: CreateSearchProvider = ({ appId, limits }) => ({
  kinds: ["item"],
  async search(req: SearchRequest): Promise<SearchHit[]> {
    if (req.kinds && req.kinds.length > 0 && !req.kinds.includes("item")) return [];
    if (req.signal?.aborted) return [];

    // The documented caps, overridden by any live values the host pushed.
    const caps = { ...HOST_LIMITS, ...limits };

    const candidates: { item: ReturnType<typeof listItems>[number]; score: number }[] = [];
    for (const item of listItems()) {
      const score = scoreFields(
        { title: item.title, secondary: item.preview, body: item.searchText },
        req.terms,
        req.query,
      );
      if (score > 0) candidates.push({ item, score });
      // Hinted-only items surface last: HINTS_FLOOR is strictly below the
      // weakest real match and strictly above 0.
      else if (isHinted(item.id, req.hints?.ids, appId)) {
        candidates.push({ item, score: HINTS_FLOOR });
      }
    }

    candidates.sort(compareHits((c) => c.item.updatedAt));
    return candidates.slice(0, Math.min(req.limit, caps.PER_PROVIDER_REQUEST_LIMIT)).map(({ item, score }) =>
      toSearchHit({
        id: item.id,
        kind: "item",
        title: item.title,
        score,
        updatedAt: item.updatedAt,
        text: item.preview,
        textPreview: true,
        openRef: { objectId: item.id, collection: "items" },
      }),
    );
  },
});
```

The rules a provider lives under (see the PROTOCOL section for the full table):

- **Honor `req.signal` and `req.limit`**, and return hits **in rank order** —
  the host fuses by rank, not raw score.
- **Stay inside `HOST_LIMITS`.** Past the caps, the host silently truncates
  strings and drops previews; a hit missing `id`/`title`/`kind` is dropped
  whole. `ctx.limits`, when present, is the host's live truth — prefer it.
- **`openRef.action` is opt-in and fail-closed.** If you set one it must name a
  declared `mutates: false` action of your own app, or the host strips it. Most
  providers set none and rely on `openArtifact`.
- **Empty query means recency mode**: return the most recently updated items.
- Fail soft — return `[]` rather than throwing; a throw just costs your app its
  slot in that fan-out.

For larger stores, the kernel also ships `queryBySearchText` (server-side
full-text pushdown over a `searchText` projection) and `createLatchedFallback`
(a one-way latch that stops re-trying the pushdown once a server has shown it
lacks the op), plus text chores (`truncateOnWord`, `SEARCH_TEXT_MAX`,
`escapeHtml`) for building the projection at write time. The docs app's
`search.ts` is the reference hybrid implementation.

## Testing

`@unifiedai/sdk/app/testkit` is framework-agnostic — it returns violation
strings and stats instead of calling any `expect`, so it runs under `bun:test`
and vitest alike:

```ts
import { describe, expect, test } from "bun:test"; // or "vitest"
import { findHitViolations, benchmark, formatBench, HOST_LIMITS } from "@unifiedai/sdk/app/testkit";
import { createSearchProvider } from "../src/search";

const provider = await createSearchProvider({ sdk: null, appId: "my-app" });
const req = (query: string) => ({
  query,
  terms: query.toLowerCase().split(/\s+/).filter(Boolean),
  limit: HOST_LIMITS.PER_PROVIDER_REQUEST_LIMIT,
  signal: new AbortController().signal,
});

test("hits satisfy the host contract", async () => {
  const hits = await provider.search(req("alpha"));
  expect(
    findHitViolations(hits, {
      limit: HOST_LIMITS.PER_PROVIDER_REQUEST_LIMIT,
      kinds: ["item"],
      nonMutatingActions: ["openItem", "openArtifact"],
    }),
  ).toEqual([]);
});

test("stays far under the per-provider budget", async () => {
  const stats = await benchmark(() => provider.search(req("alpha")));
  console.log(formatBench("my-app/common-term", stats));
  expect(stats.p95).toBeLessThan(HOST_LIMITS.PER_PROVIDER_TIMEOUT_MS / 10);
});
```

`findHitViolations` checks everything the host would silently mangle — oversize
fields, wrong kinds, duplicate hits, unsorted scores, an `openRef.action` the
host would strip — and prints the precise breakage instead of a diff of two hit
arrays. The benchmark asserts you sit far under the 1500 ms budget (which
includes your module-load time in production).

## Sharing a namespace (other apps + agents)

Any marketplace app — planner, docs, yours — exposes its `sdk.storage` /
`sdk.sync` namespace through **grants**, not a planner-specific SDK resource.
Records stay opaque JSON; you own the collection schema.

```ts
const sdk = getSdk();
await sdk.storage.grants.grant({ grantee: { type: "app", appId: "docs" }, mode: "read" });
await sdk.storage.grants.grant({ grantee: { type: "agent" }, mode: "read" });
```

Consumers then `sdk.storage.namespace("your-app-id")` or read that `ns` from
`WorkspaceSync`. In-process agents bind `storageTools(ns)` / `syncTools(ws, ns)`
with **your** collection allowlist. See PROTOCOL.md §Namespace sharing.

Local UnifiedApp/desktop injects a shared `grantStore` + `MemoryBackend` (or
`createLocalSharingRuntime()` from `@unifiedai/sdk/testing`) so this works
without production unified-api. Cloud Pro-gating (`plan_required`) stays in
the contract; deploy comes later.

## Standalone dev

`vite dev` runs your app outside the shell. The `unifiedApp()` plugin aliases
`@unified/host-api` to the SDK's dev shim (`@unifiedai/sdk/app/dev-host-api`),
which stands up a **real** `UnifiedAI` against relative `/api/v1/*` URLs —
point a Vite dev proxy at unified-api and set, in `.env`:

```
VITE_DEV_API_KEY=uapi_...   # your dev API key
```

(`VITE_UNIFIED_APP_ID` is injected by the plugin from its `appId` option.) In
the shim, `registerActions` is a no-op, theme follows the OS preference, and
the agent bridge reports itself absent — which is exactly why
`safeRegisterActions` and `hasRunAgent()` feature-detection exist. Pass
`unifiedApp({ appId, devHostApi: "./src/my-shim.ts" })` to substitute your own
shim.

## Build output

`vite build` must emit, side by side:

- `app.js` — your mounted entry (plus any CSS your setup extracts);
- `search.js` — the provider chunk, importable without `app.js`;
- `manifest.json` — copied from `public/`.

`@unified/host-api` stays **external** (rewritten to `/host-api.js`, which the
host serves); everything else — Vue included — is bundled. If either chunk
grows a surprising import (check with `grep` or a bundle visualizer), your
search entry has probably reached into the component tree.

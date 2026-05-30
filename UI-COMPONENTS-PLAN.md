# Out-of-the-box UI components — plan

Status: **Tier 1 shipped** (this PR). Tiers 2–3 are proposals for review.

## Why

The platform already has rich usage/model UI — `ModelPicker.vue`, `ModelIconStack.vue`,
`ChatUsageVis.vue`, `UsageKpiStrip.vue`, `TokenUsageCard.vue` — but it lives in
**Vue**, inside UnifiedApp's private `packages/ui`, and is **not distributable**
to third-party marketplace apps. As a result, the React app OpenDesign had to
rebuild the same things from scratch (`ModelLogo`, a logo'd model picker, a
`UsageChip` + polling hook). Every future React/Svelte marketplace app repeats
that work, and each re-derives the same usage math and logo-keying rules
slightly differently.

Goal: give app developers **ready, themeable components** while keeping the core
SDK headless and serving every framework + both auth topologies.

## Principles

1. **Core SDK stays headless.** Zero framework deps is exactly why one package
   serves Vue, React, Node, and CLIs. UI lives in *separate, optional* packages.
2. **Ship logic in the core; ship markup in framework packages.** The reusable
   value is mostly pure functions (formatting, view-models, logo keying). That
   belongs in the core SDK and benefits every framework equally.
3. **Never assume the browser holds a token.** Components take a *data-source
   function*, not a client. See [the auth-topology seam](#the-auth-topology-seam).
4. **Headless-first, themeable.** Components render minimal semantic markup
   styled entirely through CSS custom properties, so they look native in any
   host's design system. No bundled heavyweight CSS framework.
5. **The host owns wording.** The SDK emits values + short tokens (`"5h"`,
   `"1.2k"`); the host wraps them in localized sentences. Components accept a
   `labels`/`format` prop so i18n and RTL stay with the app.

## Tier 1 — core SDK helpers (DONE)

Framework-agnostic, exported from both `@unifiedai/sdk` and `@unifiedai/sdk/node`:

| Export | Purpose |
| --- | --- |
| `summarizeUsage(usage, opts?) → UsageSummary` | Raw `UsageResponse` → display-ready view-model (labels, daily ratio/percent, `isNearLimit`/`isOverLimit`, "resets in" tokens). Injectable `now`, configurable `warnThreshold`. |
| `formatTokenCount`, `formatUsd`, `formatTimeUntil` | The underlying formatters. |
| `getModelLogo(model, theme?)` | `getProviderLogo` convenience that keys on `model_author.name` → `owned_by`. |
| `getProviderLogo`, `listProviderLogos` | (existing) brand-logo data-URIs. |

This already lets UnifiedApp's Vue cards and any React UI share one source of
truth for the math — even before the component packages exist.

## Tier 2 — `@unifiedai/react` (proposed)

A new package in this repo (`packages/react/`, published as `@unifiedai/react`).
`react` is a **peerDependency** (`>=18`); the package itself stays tiny.

### Components

```tsx
// Brand logo for a model/provider. Wraps getModelLogo/getProviderLogo.
<ModelLogo author="Anthropic" theme="dark" size={18} />
<ModelLogo model={modelRow} />            // accepts a catalog Model

// Logo'd, searchable model picker (what native <select> can't do).
<ModelPicker
  models={models}                          // Array<{ id; label?; author?; ... }>
  value={modelId}
  onChange={setModelId}
  searchThreshold={8}                       // show filter past N models
  theme="dark"
  labels={{ search: t('search'), empty: t('noModels') }}
/>

// Account-usage meter + details popover, driven by summarizeUsage().
<UsageMeter
  getUsage={getUsage}                       // () => Promise<UsageResponse>  ← the seam
  pollMs={90_000}
  warnThreshold={0.9}
  variant="chip"                            // "chip" | "card"
  labels={usageLabels}                      // { title, today, period, ... }
  onError={(e) => {}}
/>
```

Internals:
- A headless `useUsage(getUsage, opts)` hook (mount + interval + focus refresh +
  `AbortController`, returning `{ summary, loading, unavailable, error, refresh }`)
  that calls `summarizeUsage` from Tier 1. This is the React-flavored port of the
  `useUnifiedUsage` hook that already exists in OpenDesign.
- A `useResolvedTheme()` hook (the `<html data-theme>` + `prefers-color-scheme`
  resolver, also already written in OpenDesign) so components are theme-aware
  without a provider.
- All markup uses class names under a single prefix (`uai-*`) + CSS custom
  properties for every color/space/radius. Ship an optional
  `@unifiedai/react/styles.css` with sensible defaults that hosts can override or
  skip entirely.

### The auth-topology seam

This is the crux. Components must work in **both** worlds:

```tsx
// App where the browser holds a token (direct to gateway):
<UsageMeter getUsage={() => sdk.usage.get()} />

// Broker/bundled app (OpenDesign): browser has NO credential — a daemon proxies.
<UsageMeter getUsage={() => fetch('/api/unified/usage').then(r => r.json()).then(j => j.usage)} />
```

Because components depend on a `() => Promise<UsageResponse>` (and plain model
arrays), not on the `UnifiedAI` client, they're decoupled from how auth is wired.
A thin convenience adapter can still be offered: `usageFromClient(sdk)` returns
`() => sdk.usage.get()` for the common case.

### Theming + i18n

- **Theming:** every visual is a CSS var (`--uai-accent`, `--uai-bg`,
  `--uai-text`, `--uai-radius`, `--uai-warn`, …). Default stylesheet sets them to
  neutral values keyed off `data-theme`; hosts remap to their tokens in one
  block. No Tailwind/Quasar coupling.
- **i18n:** components accept a `labels` object (and optional `format` overrides);
  the SDK never bakes English sentences. Defaults are English so a bare drop-in
  still reads fine.

### Build

Mirror the core: `bun build` ESM, `tsc` types, `react`/`react-dom` as peers,
`@unifiedai/sdk` as a dependency, Biome + a small Playwright/RTL test set. Add a
bundle-guard test (like `tests/bundle/browser-bundle.test.ts`) asserting no
`node:*` leakage.

## Tier 3 — `@unifiedai/vue` (proposed, later)

Same component set as Vue 3 SFCs/composables (`useUsage`, `<UsageMeter>`, …) on
the same Tier 1 helpers and the same `getUsage` seam. Lets **UnifiedApp itself**
converge: its `packages/ui` widgets (`ChatUsageVis`, `UsageKpiStrip`,
`ModelPicker`) become thin skins over the shared package, so the first-party app
and third-party apps share one implementation. Sequenced last because it's a
migration of working code, not a gap.

## Migration

- **OpenDesign (React):** once `@unifiedai/react` exists, collapse the bespoke
  `ModelLogo`, `UnifiedModelList`, `UsageChip`, `useUnifiedUsage`, and
  `useResolvedTheme` onto it — passing `getUsage={() => fetch('/api/unified/usage')…}`
  and remapping the `uai-*` CSS vars to OpenDesign's tokens. Net code deletion.
  (Today OpenDesign already benefits from Tier 1: its `UsageChip` can drop its
  hand-rolled `formatCompact`/`formatResetsIn`/ratio in favor of `summarizeUsage`.)
- **UnifiedApp (Vue):** adopt Tier 1 helpers in the existing cards now; optionally
  migrate to Tier 3 components later.

## Suggested sequencing & rough effort

1. **Tier 1 helpers** — DONE.
2. **Retrofit OpenDesign's `UsageChip` onto `summarizeUsage`** — tiny; proves the
   helpers and removes duplicated math. *(~0.5 day, needs an SDK version bump.)*
3. **`@unifiedai/react`** — package scaffold + `useUsage`/`useResolvedTheme` +
   `<ModelLogo>`/`<ModelPicker>`/`<UsageMeter>` + default styles + tests + docs.
   *(~3–5 days.)*
4. **Migrate OpenDesign onto `@unifiedai/react`.** *(~1 day.)*
5. **`@unifiedai/vue` + UnifiedApp convergence.** *(~3–5 days, optional.)*

## Open questions / decisions for review

- **Styled vs strictly headless.** Recommendation: headless markup + an *optional*
  default stylesheet (best of both). Confirm hosts are fine remapping CSS vars vs
  wanting a render-prop/slots API for full control.
- **Package home.** Monorepo-ify this repo (`packages/*`) vs separate repos.
  Recommendation: keep in this repo so the SDK + UI version and release together
  via changesets.
- **Model type surface.** `<ModelPicker>` should accept a minimal structural type
  (`{ id; label?; author?; type? }`) so it works with both the gateway `Model`
  shape and app-local option shapes (e.g. OpenDesign's `AgentModelOption`).
- **Provide a `usageFromClient(sdk)` adapter?** Recommendation: yes — removes
  boilerplate for the common browser-holds-token case while the `getUsage` seam
  keeps broker apps first-class.

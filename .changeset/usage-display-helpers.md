---
"@unifiedai/sdk": minor
---

Add framework-agnostic display helpers so every host (React, Vue, CLI, desktop)
renders usage and model branding consistently without re-deriving the same math.

- `summarizeUsage(usage, options?)` — turns a raw `UsageResponse` into a
  display-ready `UsageSummary`: compact labels, a clamped daily ratio/percent,
  `isNearLimit`/`isOverLimit` flags (configurable `warnThreshold`), and
  "resets in" tokens. Pure; accepts an injectable `now` for deterministic
  rendering/tests.
- `formatTokenCount`, `formatUsd`, `formatTimeUntil` — the underlying
  formatters, exported for direct use.
- `getModelLogo(model, theme?)` — convenience over `getProviderLogo` that keys
  on `model_author.name` (falling back to `owned_by`), so callers don't have to
  remember that logos are indexed by author name rather than model id.

These are the foundation (Tier 1) for the optional `@unifiedai/react` /
`@unifiedai/vue` component packages described in `UI-COMPONENTS-PLAN.md`.
No breaking changes; all additions are exported from both the browser and node
entries.

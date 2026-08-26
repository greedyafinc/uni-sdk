---
"@unifiedai/sdk": minor
---

Generic namespace sharing and a Pro-gated cloud persistence contract:

- `sdk.storage.grants` / `sdk.sync.grants` let any marketplace app expose a
  namespaced resource to other apps and authenticated agents (no planner
  domain types in the SDK).
- Cloud storage/fs/sync paths refuse Free (`plans.id = 0`) with
  `PlanRequiredError` (`code: "plan_required"`). Local/injected backends are
  unchanged.
- Agent packs `storageTools(ns)` and `syncTools(ws, ns)`.

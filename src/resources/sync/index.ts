// Barrel for the sync resource. Re-exported from the SDK's browser + node
// entries. All of this is browser-safe (no `node:*` imports; snapshot bytes go
// through TextEncoder/TextDecoder, not Buffer).
// NOTE: FakeSyncServer intentionally lives OUTSIDE this barrel — it is a
// test double, exposed via the "@unifiedai/sdk/testing" subpath entry so it
// never ships in the main bundles.
export { Sync } from "./sync";
export { WorkspaceSync, defaultTiming } from "./workspace";
export type { SyncTiming } from "./workspace";
export { syncError, isEpochMismatch } from "./errors";
export type { SyncErrorCode } from "./errors";
export { encodeSnapshot, decodeSnapshot } from "./snapshot";
export type { SyncSnapshot } from "./snapshot";
export type {
  SnapshotBackend,
  SyncApplyResult,
  SyncCollection,
  SyncListFilter,
  SyncOp,
  SyncRecord,
  SyncState,
  SyncStatus,
  SyncStatusObservable,
  WorkspaceSummary,
  WorkspaceSyncOptions,
} from "./types";

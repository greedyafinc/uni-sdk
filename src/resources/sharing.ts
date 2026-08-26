// Public barrel for the generic namespace-sharing contract. Re-exported from
// the SDK root so any marketplace app (planner, docs, …) can grant access
// without importing internals. See PROTOCOL.md §Namespace sharing.
export { MemoryGrantStore, namespaceAccess, notGrantedError } from "./_kv/sharing";
export type {
  ListNamespaceGrantsOptions,
  NamespaceGrant,
  NamespaceGrantInput,
  NamespaceGrantMode,
  NamespaceGrantee,
  SharingCaller,
} from "./_kv/sharing";
export { NamespaceSharing } from "./_kv/grants";
export type { SharingResource } from "./_kv/grants";

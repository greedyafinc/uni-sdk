// Barrel for the storage resource. Re-exported from the SDK's browser + node
// entries. All of this is browser-safe (no `node:*` imports).
export { Storage } from "./storage";
export { CloudStorageBackend } from "./cloud";
export { MemoryBackend } from "./memory";
export type { MemoryBackendOptions } from "./memory";
export { storageAbortError, storageError } from "./errors";
export type { StorageErrorCode } from "./errors";
export type {
  BackendPage,
  BackendQuery,
  BackendRecord,
  BackendSchema,
  BackendVersion,
  BackendWhere,
  BlobEncoding,
  Collection,
  CollectionSchema,
  Namespace,
  NamespaceMode,
  NamespaceOptions,
  OrderBy,
  OrderType,
  Page,
  Predicate,
  PredicateOps,
  PutReq,
  Query,
  SortOrder,
  StorageBackend,
  StorageCallOptions,
  StorageRecord,
  StoredRef,
  VersionMeta,
  WhereOp,
} from "./types";

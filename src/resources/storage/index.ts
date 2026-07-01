// Barrel for the storage resource. Re-exported from the SDK's browser + node
// entries. All of this is browser-safe (no `node:*` imports).
export { Storage } from "./storage";
export { CloudStorageBackend } from "./cloud";
export { MemoryBackend } from "./memory";
export { storageError } from "./errors";
export type { StorageErrorCode } from "./errors";
export type {
  BackendQuery,
  BackendRecord,
  BackendSchema,
  BackendVersion,
  BlobEncoding,
  Collection,
  CollectionSchema,
  Namespace,
  NamespaceMode,
  NamespaceOptions,
  PutReq,
  Query,
  SortOrder,
  StorageBackend,
  StorageRecord,
  StoredRef,
  VersionMeta,
} from "./types";

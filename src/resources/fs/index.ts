// Barrel for the fs resource. Re-exported from the SDK's browser + node entries.
// All of this is browser-safe (no `node:*` imports).
export { Fs } from "./fs";
export { OpfsBackend } from "./opfs";
export { fsError } from "./errors";
export type { FsErrorCode } from "./errors";
export { normalizeRelPath, normalizePrefix, normalizeNs } from "./path";
export type {
  FsBackend,
  FsEncoding,
  FsEntry,
  FsListOptions,
  FsNamespace,
  FsNamespaceMode,
  FsNamespaceOptions,
  FsStat,
  FsWriteReq,
} from "./types";

// The shared record field-set for the SDK's namespaced record stores.
// INTERNAL — not exported from any public barrel.
//
// Four record shapes in storage/ and sync/ share this field set; the sync-side
// trio (the engine's wire records, the public `SyncRecord`, and the
// FakeSyncServer's server records) are field-for-field identical. The INTERNAL
// shapes alias `SyncedRecordFields` directly; the PUBLIC interfaces
// (`storage/types.ts` `BackendRecord`, `sync/types.ts` `SyncRecord`) stay
// literal so their emitted declarations (and per-field doc comments) are
// byte-stable — the compiler enforces structural parity wherever records cross
// between the shapes (e.g. `fromWire()` building a `SyncRecord`).

/** Bookkeeping fields every stored record carries. */
export interface RecordCoreFields {
  id: string;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: number;
  updatedAt: number;
  hasBlob: boolean;
}

/**
 * The sync-side record shape: addressed by `(ns, collection)` inline, stamped
 * with the server's monotonic `syncId`, and carrying a tombstone flag.
 * `blobEncoding` is a plain string on this side of the wire (the server does
 * not constrain it to storage's `BlobEncoding` union).
 */
export interface SyncedRecordFields extends RecordCoreFields {
  ns: string;
  collection: string;
  deleted: boolean;
  syncId: number;
  blobEncoding?: string;
}

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
//# sourceMappingURL=records.d.ts.map
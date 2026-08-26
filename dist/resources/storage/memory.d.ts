import type { BackendPage, BackendQuery, BackendRecord, BackendVersion, PutReq, StorageBackend, StorageCallOptions, StoredRef } from "./types.js";
export declare class MemoryBackend implements StorageBackend {
    readonly name = "memory";
    private readonly objects;
    private readonly blobs;
    private readonly versions;
    available(): boolean;
    ensureCollection(): Promise<void>;
    put(req: PutReq): Promise<StoredRef>;
    get(ns: string, collection: string, id: string, opts?: StorageCallOptions): Promise<BackendRecord | null>;
    private matching;
    query(ns: string, collection: string, q: BackendQuery, opts?: StorageCallOptions): Promise<BackendPage>;
    count(ns: string, collection: string, q: BackendQuery, opts?: StorageCallOptions): Promise<number>;
    delete(ns: string, collection: string, id: string): Promise<boolean>;
    readBlob(ns: string, collection: string, id: string, opts?: StorageCallOptions): Promise<Uint8Array | null>;
    listVersions(ns: string, collection: string, id: string): Promise<BackendVersion[]>;
    getVersion(ns: string, collection: string, id: string, version: number): Promise<BackendRecord | null>;
    readVersionBlob(ns: string, collection: string, id: string, version: number): Promise<Uint8Array | null>;
    revert(ns: string, collection: string, id: string, version: number): Promise<StoredRef>;
}
//# sourceMappingURL=memory.d.ts.map
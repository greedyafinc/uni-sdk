import type { Core } from "../../core/core.js";
import type { BackendPage, BackendQuery, BackendRecord, BackendVersion, PutReq, StorageBackend, StorageCallOptions, StoredRef } from "./types.js";
export declare class CloudStorageBackend implements StorageBackend {
    private readonly client;
    readonly name = "cloud";
    constructor(client: Core);
    private post;
    available(): boolean;
    ensureCollection(): Promise<void>;
    put(req: PutReq): Promise<StoredRef>;
    get(ns: string, collection: string, id: string, opts?: StorageCallOptions): Promise<BackendRecord | null>;
    query(ns: string, collection: string, query: BackendQuery, opts?: StorageCallOptions): Promise<BackendPage>;
    /**
     * `/count-v2` shares `/query-v2`'s exact where-compilation, so every
     * operator (including `match`) counts consistently with `query()` — in a
     * single request. It rejects `limit`/`after` (a page-scoped count would be
     * a wrong answer dressed as a right one), so those are stripped here even
     * though callers shouldn't be passing them for a count.
     */
    count(ns: string, collection: string, query: BackendQuery, opts?: StorageCallOptions): Promise<number>;
    delete(ns: string, collection: string, id: string): Promise<boolean>;
    readBlob(ns: string, collection: string, id: string, opts?: StorageCallOptions): Promise<Uint8Array | null>;
    listVersions(ns: string, collection: string, id: string): Promise<BackendVersion[]>;
    getVersion(ns: string, collection: string, id: string, version: number): Promise<BackendRecord | null>;
    readVersionBlob(ns: string, collection: string, id: string, version: number): Promise<Uint8Array | null>;
    revert(ns: string, collection: string, id: string, version: number): Promise<StoredRef>;
}
//# sourceMappingURL=cloud.d.ts.map
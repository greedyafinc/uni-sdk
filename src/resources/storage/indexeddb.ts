// Browser IndexedDB StorageBackend — the default, zero-config local store used
// when no host backend is injected. `indexedDB` is referenced ONLY inside
// methods (never at module load) so this stays safe to import in any runtime;
// `available()` gates use to environments that actually have it.
//
// This is the portable fallback, not the optimized path: it range-scans a
// collection and filters/sorts in JS. The Tauri host backend (SQLite + files)
// is where indexed queries and content-addressed blobs live.
import { applyQuery, cpkOf, pkOf, toArrayBuffer, vpkOf } from "./backend-util";
import { storageError } from "./errors";
import type {
  BackendQuery,
  BackendRecord,
  BackendVersion,
  BlobEncoding,
  PutReq,
  StorageBackend,
  StoredRef,
} from "./types";

const DB_NAME = "unifiedai-storage";
const DB_VERSION = 1;

interface ObjRow {
  pk: string;
  cpk: string;
  id: string;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: number;
  updatedAt: number;
  hasBlob: boolean;
  blobEncoding?: BlobEncoding;
}

interface BlobRow {
  pk: string;
  bytes: ArrayBuffer;
}

interface VerRow {
  vpk: string;
  opk: string;
  version: number;
  metadata: Record<string, unknown>;
  createdAt: number;
  hasBlob: boolean;
  blobEncoding?: BlobEncoding;
  bytes?: ArrayBuffer;
}

function reqP<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function toRecord(row: ObjRow): BackendRecord {
  return {
    id: row.id,
    metadata: row.metadata,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hasBlob: row.hasBlob,
    ...(row.blobEncoding ? { blobEncoding: row.blobEncoding } : {}),
  };
}

export class IndexedDbBackend implements StorageBackend {
  readonly name = "indexeddb";
  private dbPromise: Promise<IDBDatabase> | null = null;

  available(): boolean {
    return typeof indexedDB !== "undefined";
  }

  private db(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    const p = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(storageError("storage_unavailable", "IndexedDB is not available in this runtime"));
        return;
      }
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains("objects")) {
          const s = db.createObjectStore("objects", { keyPath: "pk" });
          s.createIndex("by_cpk", "cpk");
        }
        if (!db.objectStoreNames.contains("blobs")) {
          db.createObjectStore("blobs", { keyPath: "pk" });
        }
        if (!db.objectStoreNames.contains("versions")) {
          const s = db.createObjectStore("versions", { keyPath: "vpk" });
          s.createIndex("by_opk", "opk");
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
      // A concurrent tab holding an older version open blocks the upgrade.
      open.onblocked = () =>
        reject(storageError("storage_unavailable", "IndexedDB upgrade blocked by another tab"));
    });
    // Don't memoize a rejection: a transient open failure (private-mode quirk,
    // a tab that later closes) would otherwise brick storage for the whole page
    // session. Clear the cache on failure so the next call re-attempts open().
    const wrapped = p.catch((err) => {
      if (this.dbPromise === wrapped) this.dbPromise = null;
      throw err;
    });
    this.dbPromise = wrapped;
    return wrapped;
  }

  async ensureCollection(): Promise<void> {
    // Schemaless: the object stores are global and indexes are applied in JS.
    await this.db();
  }

  async put(req: PutReq): Promise<StoredRef> {
    const db = await this.db();
    const now = Date.now();
    const pk = pkOf(req.ns, req.collection, req.id);
    const tx = db.transaction(["objects", "blobs", "versions"], "readwrite");
    const objects = tx.objectStore("objects");
    const existing = await reqP<ObjRow | undefined>(objects.get(pk));
    const version = (existing?.version ?? 0) + 1;
    const createdAt = existing?.createdAt ?? now;
    const row: ObjRow = {
      pk,
      cpk: cpkOf(req.ns, req.collection),
      id: req.id,
      metadata: req.metadata,
      version,
      createdAt,
      updatedAt: now,
      hasBlob: req.blob !== undefined,
      ...(req.blobEncoding ? { blobEncoding: req.blobEncoding } : {}),
    };
    objects.put(row);
    const blobs = tx.objectStore("blobs");
    if (req.blob !== undefined) {
      const blobRow: BlobRow = { pk, bytes: toArrayBuffer(req.blob) };
      blobs.put(blobRow);
    } else {
      blobs.delete(pk);
    }
    if (req.versioned) {
      const verRow: VerRow = {
        vpk: vpkOf(req.ns, req.collection, req.id, version),
        opk: pk,
        version,
        metadata: req.metadata,
        createdAt: now,
        hasBlob: req.blob !== undefined,
        ...(req.blobEncoding ? { blobEncoding: req.blobEncoding } : {}),
        ...(req.blob !== undefined ? { bytes: toArrayBuffer(req.blob) } : {}),
      };
      tx.objectStore("versions").put(verRow);
    }
    await txDone(tx);
    return { id: req.id, version, updatedAt: now };
  }

  async get(ns: string, collection: string, id: string): Promise<BackendRecord | null> {
    const db = await this.db();
    const tx = db.transaction("objects", "readonly");
    const row = await reqP<ObjRow | undefined>(
      tx.objectStore("objects").get(pkOf(ns, collection, id)),
    );
    return row ? toRecord(row) : null;
  }

  async query(ns: string, collection: string, q: BackendQuery): Promise<BackendRecord[]> {
    const db = await this.db();
    const tx = db.transaction("objects", "readonly");
    const rows = await reqP<ObjRow[]>(
      tx
        .objectStore("objects")
        .index("by_cpk")
        .getAll(IDBKeyRange.only(cpkOf(ns, collection))),
    );
    return applyQuery(rows, q).map(toRecord);
  }

  async count(ns: string, collection: string, q: BackendQuery): Promise<number> {
    const db = await this.db();
    const tx = db.transaction("objects", "readonly");
    const rows = await reqP<ObjRow[]>(
      tx
        .objectStore("objects")
        .index("by_cpk")
        .getAll(IDBKeyRange.only(cpkOf(ns, collection))),
    );
    const where = q.where;
    return applyQuery(rows, where ? { where } : {}).length;
  }

  async delete(ns: string, collection: string, id: string): Promise<boolean> {
    const db = await this.db();
    const pk = pkOf(ns, collection, id);
    const tx = db.transaction(["objects", "blobs", "versions"], "readwrite");
    const objects = tx.objectStore("objects");
    const existing = await reqP<ObjRow | undefined>(objects.get(pk));
    objects.delete(pk);
    tx.objectStore("blobs").delete(pk);
    const versions = tx.objectStore("versions");
    const vkeys = await reqP<IDBValidKey[]>(
      versions.index("by_opk").getAllKeys(IDBKeyRange.only(pk)),
    );
    for (const k of vkeys) versions.delete(k);
    await txDone(tx);
    return existing !== undefined;
  }

  async readBlob(ns: string, collection: string, id: string): Promise<Uint8Array | null> {
    const db = await this.db();
    const tx = db.transaction("blobs", "readonly");
    const row = await reqP<BlobRow | undefined>(
      tx.objectStore("blobs").get(pkOf(ns, collection, id)),
    );
    return row ? new Uint8Array(row.bytes) : null;
  }

  async listVersions(ns: string, collection: string, id: string): Promise<BackendVersion[]> {
    const db = await this.db();
    const tx = db.transaction("versions", "readonly");
    const rows = await reqP<VerRow[]>(
      tx
        .objectStore("versions")
        .index("by_opk")
        .getAll(IDBKeyRange.only(pkOf(ns, collection, id))),
    );
    return rows
      .map((v) => ({ version: v.version, createdAt: v.createdAt, hasBlob: v.hasBlob }))
      .sort((a, b) => b.version - a.version);
  }

  async getVersion(
    ns: string,
    collection: string,
    id: string,
    version: number,
  ): Promise<BackendRecord | null> {
    const db = await this.db();
    const tx = db.transaction("versions", "readonly");
    const v = await reqP<VerRow | undefined>(
      tx.objectStore("versions").get(vpkOf(ns, collection, id, version)),
    );
    if (!v) return null;
    return {
      id,
      metadata: v.metadata,
      version: v.version,
      createdAt: v.createdAt,
      updatedAt: v.createdAt,
      hasBlob: v.hasBlob,
      ...(v.blobEncoding ? { blobEncoding: v.blobEncoding } : {}),
    };
  }

  async readVersionBlob(
    ns: string,
    collection: string,
    id: string,
    version: number,
  ): Promise<Uint8Array | null> {
    const db = await this.db();
    const tx = db.transaction("versions", "readonly");
    const v = await reqP<VerRow | undefined>(
      tx.objectStore("versions").get(vpkOf(ns, collection, id, version)),
    );
    return v?.bytes ? new Uint8Array(v.bytes) : null;
  }

  async revert(ns: string, collection: string, id: string, version: number): Promise<StoredRef> {
    const db = await this.db();
    const tx = db.transaction("versions", "readonly");
    const v = await reqP<VerRow | undefined>(
      tx.objectStore("versions").get(vpkOf(ns, collection, id, version)),
    );
    if (!v) throw storageError("not_found", `version ${version} not found for "${id}"`);
    return this.put({
      ns,
      collection,
      id,
      metadata: v.metadata,
      versioned: true,
      ...(v.bytes !== undefined ? { blob: new Uint8Array(v.bytes) } : {}),
      ...(v.blobEncoding ? { blobEncoding: v.blobEncoding } : {}),
    });
  }
}

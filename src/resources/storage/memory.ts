// In-memory StorageBackend. Used by tests and as an explicit opt-in backend
// when no server is available. Not persistent — everything is lost on reload.
import { cpkOf, pkOf, vpkOf } from "../_kv/keys";
import { applyQuery } from "../_kv/query";
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

interface ObjRow {
  ns: string;
  collection: string;
  id: string;
  cpk: string;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: number;
  updatedAt: number;
  hasBlob: boolean;
  blobEncoding?: BlobEncoding;
}

interface VerRow {
  opk: string;
  version: number;
  metadata: Record<string, unknown>;
  createdAt: number;
  hasBlob: boolean;
  blobEncoding?: BlobEncoding;
  bytes?: Uint8Array;
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

export class MemoryBackend implements StorageBackend {
  readonly name = "memory";

  private readonly objects = new Map<string, ObjRow>();
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly versions = new Map<string, VerRow>();

  available(): boolean {
    return true;
  }

  ensureCollection(): Promise<void> {
    return Promise.resolve();
  }

  put(req: PutReq): Promise<StoredRef> {
    const now = Date.now();
    const pk = pkOf(req.ns, req.collection, req.id);
    const existing = this.objects.get(pk);
    const version = (existing?.version ?? 0) + 1;
    const createdAt = existing?.createdAt ?? now;
    const row: ObjRow = {
      ns: req.ns,
      collection: req.collection,
      id: req.id,
      cpk: cpkOf(req.ns, req.collection),
      metadata: req.metadata,
      version,
      createdAt,
      updatedAt: now,
      hasBlob: req.blob !== undefined,
      ...(req.blobEncoding ? { blobEncoding: req.blobEncoding } : {}),
    };
    this.objects.set(pk, row);
    if (req.blob !== undefined) this.blobs.set(pk, req.blob.slice());
    else this.blobs.delete(pk);
    if (req.versioned) {
      this.versions.set(vpkOf(req.ns, req.collection, req.id, version), {
        opk: pk,
        version,
        metadata: req.metadata,
        createdAt: now,
        hasBlob: req.blob !== undefined,
        ...(req.blobEncoding ? { blobEncoding: req.blobEncoding } : {}),
        ...(req.blob !== undefined ? { bytes: req.blob.slice() } : {}),
      });
    }
    return Promise.resolve({ id: req.id, version, updatedAt: now });
  }

  get(ns: string, collection: string, id: string): Promise<BackendRecord | null> {
    const row = this.objects.get(pkOf(ns, collection, id));
    return Promise.resolve(row ? toRecord(row) : null);
  }

  query(ns: string, collection: string, q: BackendQuery): Promise<BackendRecord[]> {
    const cpk = cpkOf(ns, collection);
    const rows: ObjRow[] = [];
    for (const row of this.objects.values()) if (row.cpk === cpk) rows.push(row);
    return Promise.resolve(applyQuery(rows, q).map(toRecord));
  }

  count(ns: string, collection: string, q: BackendQuery): Promise<number> {
    const cpk = cpkOf(ns, collection);
    const rows: ObjRow[] = [];
    for (const row of this.objects.values()) if (row.cpk === cpk) rows.push(row);
    const where = q.where;
    return Promise.resolve(applyQuery(rows, where ? { where } : {}).length);
  }

  delete(ns: string, collection: string, id: string): Promise<boolean> {
    const pk = pkOf(ns, collection, id);
    const existed = this.objects.delete(pk);
    this.blobs.delete(pk);
    for (const [vpk, v] of this.versions) if (v.opk === pk) this.versions.delete(vpk);
    return Promise.resolve(existed);
  }

  readBlob(ns: string, collection: string, id: string): Promise<Uint8Array | null> {
    const b = this.blobs.get(pkOf(ns, collection, id));
    return Promise.resolve(b ? b.slice() : null);
  }

  listVersions(ns: string, collection: string, id: string): Promise<BackendVersion[]> {
    const opk = pkOf(ns, collection, id);
    const out: BackendVersion[] = [];
    for (const v of this.versions.values()) {
      if (v.opk === opk)
        out.push({ version: v.version, createdAt: v.createdAt, hasBlob: v.hasBlob });
    }
    out.sort((a, b) => b.version - a.version);
    return Promise.resolve(out);
  }

  getVersion(
    ns: string,
    collection: string,
    id: string,
    version: number,
  ): Promise<BackendRecord | null> {
    const v = this.versions.get(vpkOf(ns, collection, id, version));
    if (!v) return Promise.resolve(null);
    return Promise.resolve({
      id,
      metadata: v.metadata,
      version: v.version,
      createdAt: v.createdAt,
      updatedAt: v.createdAt,
      hasBlob: v.hasBlob,
      ...(v.blobEncoding ? { blobEncoding: v.blobEncoding } : {}),
    });
  }

  readVersionBlob(
    ns: string,
    collection: string,
    id: string,
    version: number,
  ): Promise<Uint8Array | null> {
    const v = this.versions.get(vpkOf(ns, collection, id, version));
    return Promise.resolve(v?.bytes ? v.bytes.slice() : null);
  }

  async revert(ns: string, collection: string, id: string, version: number): Promise<StoredRef> {
    const v = this.versions.get(vpkOf(ns, collection, id, version));
    if (!v) throw storageError("not_found", `version ${version} not found for "${id}"`);
    return this.put({
      ns,
      collection,
      id,
      metadata: v.metadata,
      versioned: true,
      ...(v.bytes !== undefined ? { blob: v.bytes.slice() } : {}),
      ...(v.blobEncoding ? { blobEncoding: v.blobEncoding } : {}),
    });
  }
}

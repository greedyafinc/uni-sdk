// In-memory StorageBackend. Used by tests and as an explicit opt-in backend
// when no server is available. Not persistent — everything is lost on reload.
//
// It is a CONFORMANCE TWIN of the cloud backend, not a convenience mock: the
// predicate semantics, the null-stripping write path, the id tiebreak, the page
// clamps, and the keyset cursor all mirror unified-api exactly (see
// predicate.ts). A JS-flavoured shortcut here would make every test that runs
// against it lie about production.
import { cpkOf, pkOf, vpkOf } from "../_kv/keys";
import { storageError, throwIfAborted } from "./errors";
import { clampPage, compareValues, cursorForRow, decodeCursor, matchesWhere } from "./predicate";
import type {
  BackendPage,
  BackendQuery,
  BackendRecord,
  BackendVersion,
  BlobEncoding,
  PutReq,
  StorageBackend,
  StorageCallOptions,
  StoredRef,
} from "./types";

/**
 * Mirror of Postgres `jsonb_strip_nulls`, which the server's write RPC applies
 * to every metadata patch. Without it "stored null" and "absent key" would be
 * distinguishable here but not in the cloud, and `{ exists: false }` /
 * `where: { x: null }` would disagree between the two backends.
 * Like Postgres, it strips null OBJECT members and does not touch arrays.
 */
function stripNulls(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue;
    out[k] =
      v && typeof v === "object" && !Array.isArray(v) && v.constructor === Object
        ? stripNulls(v as Record<string, unknown>)
        : v;
  }
  return out;
}

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
    const metadata = stripNulls(req.metadata);
    const pk = pkOf(req.ns, req.collection, req.id);
    const existing = this.objects.get(pk);
    const version = (existing?.version ?? 0) + 1;
    const createdAt = existing?.createdAt ?? now;
    const row: ObjRow = {
      ns: req.ns,
      collection: req.collection,
      id: req.id,
      cpk: cpkOf(req.ns, req.collection),
      metadata,
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
        metadata,
        createdAt: now,
        hasBlob: req.blob !== undefined,
        ...(req.blobEncoding ? { blobEncoding: req.blobEncoding } : {}),
        ...(req.blob !== undefined ? { bytes: req.blob.slice() } : {}),
      });
    }
    return Promise.resolve({ id: req.id, version, updatedAt: now });
  }

  get(
    ns: string,
    collection: string,
    id: string,
    opts?: StorageCallOptions,
  ): Promise<BackendRecord | null> {
    throwIfAborted(opts?.signal, `get on "${collection}"`);
    const row = this.objects.get(pkOf(ns, collection, id));
    return Promise.resolve(row ? toRecord(row) : null);
  }

  private matching(ns: string, collection: string, q: BackendQuery): ObjRow[] {
    const cpk = cpkOf(ns, collection);
    const rows: ObjRow[] = [];
    for (const row of this.objects.values()) {
      if (row.cpk === cpk && matchesWhere(row.metadata, q.where)) rows.push(row);
    }
    return rows;
  }

  query(
    ns: string,
    collection: string,
    q: BackendQuery,
    opts?: StorageCallOptions,
  ): Promise<BackendPage> {
    throwIfAborted(opts?.signal, `query on "${collection}"`);
    const field = q.orderBy?.field;
    const type = q.orderBy?.type;
    const dir = q.orderBy?.dir === "desc" ? -1 : 1;
    const rows = this.matching(ns, collection, q);

    // `id` ascending is ALWAYS the final tiebreak (and the sole key when there
    // is no orderBy) — same as the server, and what makes the keyset stable.
    rows.sort((a, b) => {
      if (field) {
        const c = compareValues(a.metadata[field], b.metadata[field], type) * dir;
        if (c !== 0) return c;
      }
      return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
    });

    let page = rows;
    if (q.after) {
      const cursor = decodeCursor(q.after);
      if (field) {
        // `cursor.o` is absent when the row the previous page ended on had no
        // value for `field` — i.e. it was in the null block. `compareValues`
        // already ranks `undefined` the same way it ranks a stored null (the
        // largest value), so passing it straight through reproduces the
        // server's resume rule with no special case: ascending, the null
        // block is the tail, so only later null-block rows (by id) remain;
        // descending, the null block is the head, so every non-null row is
        // still ahead PLUS later null-block rows (by id).
        page = rows.filter((r) => {
          const c = compareValues(r.metadata[field], cursor.o, type) * dir;
          return c > 0 || (c === 0 && r.id > cursor.i);
        });
      } else {
        page = rows.filter((r) => r.id > cursor.i);
      }
    }

    const limit = clampPage(q.limit);
    const hasMore = page.length > limit;
    const slice = hasMore ? page.slice(0, limit) : page;
    const last = slice[slice.length - 1];
    return Promise.resolve({
      records: slice.map(toRecord),
      ...(hasMore && last
        ? { nextCursor: cursorForRow(field ? last.metadata[field] : undefined, last.id) }
        : {}),
    });
  }

  count(
    ns: string,
    collection: string,
    q: BackendQuery,
    opts?: StorageCallOptions,
  ): Promise<number> {
    throwIfAborted(opts?.signal, `count on "${collection}"`);
    return Promise.resolve(this.matching(ns, collection, q).length);
  }

  delete(ns: string, collection: string, id: string): Promise<boolean> {
    const pk = pkOf(ns, collection, id);
    const existed = this.objects.delete(pk);
    this.blobs.delete(pk);
    for (const [vpk, v] of this.versions) if (v.opk === pk) this.versions.delete(vpk);
    return Promise.resolve(existed);
  }

  readBlob(
    ns: string,
    collection: string,
    id: string,
    opts?: StorageCallOptions,
  ): Promise<Uint8Array | null> {
    throwIfAborted(opts?.signal, `readBlob on "${collection}"`);
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

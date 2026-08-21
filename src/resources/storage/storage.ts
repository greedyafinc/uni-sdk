// `sdk.storage` — the typed facade over a swappable StorageBackend. The app
// declares typed collections; this layer encodes/decodes blob fields, applies
// the read-only namespace guard, and casts untyped backend records back to `T`.
// The backend is the server-backed Cloud store (unified-api → Supabase) whenever
// a token is configured; a host may inject its own via `UnifiedAIOptions.storage`.
// With no token and no injected backend, `sdk.storage` is unavailable — there is
// no local browser fallback. See STORAGE-SPEC.md.
import type { Core } from "../../core/core";
import {
  BackendResolver,
  assertWritableNamespace,
  deriveNamespace,
  requireAvailableBackend,
} from "../_kv/namespace";
import { CloudStorageBackend } from "./cloud";
import { storageError } from "./errors";
import type {
  BackendQuery,
  BackendRecord,
  BlobEncoding,
  Collection,
  CollectionSchema,
  Namespace,
  NamespaceMode,
  NamespaceOptions,
  PutReq,
  Query,
  StorageBackend,
  StorageRecord,
  StoredRef,
  VersionMeta,
} from "./types";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

function encodeBlob(raw: unknown): { bytes: Uint8Array; encoding: BlobEncoding } {
  if (typeof raw === "string") return { bytes: utf8Encoder.encode(raw), encoding: "utf8" };
  if (raw instanceof Uint8Array) return { bytes: raw, encoding: "binary" };
  // Tag ArrayBuffer separately so `get()` returns an ArrayBuffer (not a
  // Uint8Array view) — the two are not interchangeable for callers.
  if (raw instanceof ArrayBuffer) return { bytes: new Uint8Array(raw), encoding: "arraybuffer" };
  throw storageError("invalid_input", "blob field must be a string, Uint8Array, or ArrayBuffer");
}

function decodeBlob(
  bytes: Uint8Array,
  encoding: BlobEncoding | undefined,
): string | Uint8Array | ArrayBuffer {
  if (encoding === "utf8") return utf8Decoder.decode(bytes);
  // `slice()` detaches a standalone buffer — the stored Uint8Array may be a
  // view over a larger backing buffer.
  if (encoding === "arraybuffer") return bytes.slice().buffer as ArrayBuffer;
  return bytes;
}

class CollectionImpl<T extends StorageRecord> implements Collection<T> {
  private readonly blobField: string | undefined;
  private readonly versioned: boolean;
  private ensurePromise: Promise<void> | null = null;

  constructor(
    private readonly backend: StorageBackend | null,
    private readonly ns: string,
    private readonly name: string,
    private readonly schema: CollectionSchema<T>,
    private readonly mode: NamespaceMode,
  ) {
    this.blobField = schema.blob;
    this.versioned = schema.versioned === true;
  }

  private requireBackend(): StorageBackend {
    return requireAvailableBackend(this.backend, "storage");
  }

  private assertWritable(): void {
    assertWritableNamespace(this.mode, this.ns, "storage");
  }

  private ensure(backend: StorageBackend): Promise<void> {
    if (!this.ensurePromise) {
      this.ensurePromise = backend.ensureCollection(this.ns, this.name, {
        key: this.schema.key,
        indexes: Array.from(this.schema.indexes ?? []),
        ...(this.blobField ? { blobField: this.blobField } : {}),
        versioned: this.versioned,
      });
    }
    return this.ensurePromise;
  }

  private idOf(value: T): string {
    const keyVal = value[this.schema.key];
    const id = keyVal === undefined || keyVal === null ? "" : String(keyVal);
    if (!id) {
      throw storageError("invalid_input", `record is missing required key "${this.schema.key}"`);
    }
    return id;
  }

  private hydrate(rec: BackendRecord, blob: Uint8Array | null): T {
    const out: Record<string, unknown> = { ...rec.metadata };
    if (this.blobField && blob) {
      out[this.blobField] = decodeBlob(blob, rec.blobEncoding);
    }
    return out as T;
  }

  private toBackendQuery(q: Query<T>): BackendQuery {
    // The blob field is stored out-of-line and is absent from the queryable
    // metadata, so filtering/ordering by it can never match. Fail loud instead
    // of silently returning an empty set.
    if (this.blobField) {
      if (q.where && this.blobField in q.where) {
        throw storageError("invalid_input", `cannot filter on blob field "${this.blobField}"`);
      }
      if (q.orderBy === this.blobField) {
        throw storageError("invalid_input", `cannot order by blob field "${this.blobField}"`);
      }
    }
    const out: BackendQuery = {};
    if (q.where) out.where = q.where as Record<string, unknown>;
    if (q.orderBy) out.orderBy = q.orderBy;
    if (q.order) out.order = q.order;
    if (q.limit !== undefined) out.limit = q.limit;
    if (q.offset !== undefined) out.offset = q.offset;
    return out;
  }

  async put(value: T): Promise<StoredRef> {
    this.assertWritable();
    const backend = this.requireBackend();
    await this.ensure(backend);
    const id = this.idOf(value);
    const metadata: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    let blob: Uint8Array | undefined;
    let blobEncoding: BlobEncoding | undefined;
    if (this.blobField) {
      const raw = metadata[this.blobField];
      delete metadata[this.blobField];
      if (raw !== undefined && raw !== null) {
        const enc = encodeBlob(raw);
        blob = enc.bytes;
        blobEncoding = enc.encoding;
      }
    }
    const req: PutReq = {
      ns: this.ns,
      collection: this.name,
      id,
      metadata,
      versioned: this.versioned,
      ...(blob !== undefined && blobEncoding !== undefined ? { blob, blobEncoding } : {}),
    };
    return backend.put(req);
  }

  async get(id: string): Promise<T | null> {
    const backend = this.requireBackend();
    await this.ensure(backend);
    const rec = await backend.get(this.ns, this.name, id);
    if (!rec) return null;
    const blob =
      this.blobField && rec.hasBlob ? await backend.readBlob(this.ns, this.name, id) : null;
    return this.hydrate(rec, blob);
  }

  async query(q: Query<T> = {}): Promise<T[]> {
    const backend = this.requireBackend();
    await this.ensure(backend);
    const recs = await backend.query(this.ns, this.name, this.toBackendQuery(q));
    // Blob field is intentionally omitted from scans — use get() for it.
    return recs.map((r) => ({ ...r.metadata }) as T);
  }

  async count(q: Query<T> = {}): Promise<number> {
    const backend = this.requireBackend();
    await this.ensure(backend);
    const bq = this.toBackendQuery(q);
    return backend.count(this.ns, this.name, bq.where ? { where: bq.where } : {});
  }

  async delete(id: string): Promise<boolean> {
    this.assertWritable();
    const backend = this.requireBackend();
    await this.ensure(backend);
    return backend.delete(this.ns, this.name, id);
  }

  del(id: string): Promise<boolean> {
    return this.delete(id);
  }

  async blob(id: string): Promise<Uint8Array | null> {
    const backend = this.requireBackend();
    await this.ensure(backend);
    return backend.readBlob(this.ns, this.name, id);
  }

  async versions(id: string): Promise<VersionMeta[]> {
    const backend = this.requireBackend();
    await this.ensure(backend);
    const list = await backend.listVersions(this.ns, this.name, id);
    return list.map((v) => ({ version: v.version, createdAt: v.createdAt }));
  }

  async getVersion(id: string, version: number): Promise<T | null> {
    const backend = this.requireBackend();
    await this.ensure(backend);
    const rec = await backend.getVersion(this.ns, this.name, id, version);
    if (!rec) return null;
    const blob =
      this.blobField && rec.hasBlob
        ? await backend.readVersionBlob(this.ns, this.name, id, version)
        : null;
    return this.hydrate(rec, blob);
  }

  async revert(id: string, version: number): Promise<StoredRef> {
    this.assertWritable();
    const backend = this.requireBackend();
    await this.ensure(backend);
    return backend.revert(this.ns, this.name, id, version);
  }
}

class NamespaceImpl implements Namespace {
  constructor(
    private readonly backend: StorageBackend | null,
    readonly id: string,
    readonly mode: NamespaceMode,
  ) {}

  collection<T extends StorageRecord>(name: string, schema: CollectionSchema<T>): Collection<T> {
    return new CollectionImpl<T>(this.backend, this.id, name, schema, this.mode);
  }
}

/**
 * Local-first, app-namespaced storage. Reached as `sdk.storage`.
 *
 * `namespace()` opens the calling app's own (read-write) namespace; the
 * namespace id is derived from the client's `appId` (host-stamped per app).
 * `namespace("other-app", { mode: "read" })` opens another app's data — in the
 * host this is gated by a user-granted capability and enforced at the trusted
 * boundary, not here.
 */
export class Storage {
  // Shared resolution machinery: injected backend wins → server-capable clients
  // get a lazily-built (cached) CloudStorageBackend → null (Supabase-only;
  // there is no local browser IndexedDB fallback).
  private readonly resolver: BackendResolver<StorageBackend>;

  constructor(private readonly client: Core) {
    this.resolver = new BackendResolver(
      () => client.storageBackend,
      () => client.serverCapable,
      () => new CloudStorageBackend(client),
    );
  }

  /** Whether a usable storage backend exists in the current runtime. */
  available(): boolean {
    return this.resolver.available();
  }

  /** Open a namespace handle (defaults to the calling app's own namespace). */
  namespace(appId?: string, opts: NamespaceOptions = {}): Namespace {
    const { id, mode } = deriveNamespace(this.client.appId, appId, opts.mode);
    return new NamespaceImpl(this.resolver.resolve(), id, mode);
  }
}

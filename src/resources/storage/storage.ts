// `sdk.storage` — the typed facade over a swappable StorageBackend. The app
// declares typed collections; this layer encodes/decodes blob fields, applies
// the read-only namespace guard, and casts untyped backend records back to `T`.
// The backend is the server-backed Cloud store (unified-api → Supabase) whenever
// a token is configured; a host may inject its own via `UnifiedAIOptions.storage`.
// With no token and no injected backend, `sdk.storage` is unavailable — there is
// no local browser fallback. See STORAGE-SPEC.md.
import type { Core } from "../../core/core";
import { NamespaceSharing } from "../_kv/grants";
import {
  BackendResolver,
  assertWritableNamespace,
  deriveNamespace,
  requireAvailableBackend,
} from "../_kv/namespace";
import { CloudStorageBackend } from "./cloud";
import { storageError, throwIfAborted } from "./errors";
import { MemoryBackend } from "./memory";
import { MAX_PAGE, compileWhere } from "./predicate";
import type {
  BackendQuery,
  BackendRecord,
  BlobEncoding,
  Collection,
  CollectionSchema,
  Namespace,
  NamespaceMode,
  NamespaceOptions,
  OrderType,
  Page,
  PutReq,
  Query,
  StorageBackend,
  StorageCallOptions,
  StorageRecord,
  StoredRef,
  VersionMeta,
} from "./types";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/**
 * Safety net for the unbounded `query()` scan. The server caps a page at 1000
 * rows, so this bounds one call at 100k. Hitting it means the caller wanted a
 * `limit` (or `page()`) and didn't say so — fail loudly rather than quietly
 * hammering the API.
 */
const MAX_SCAN_PAGES = 100;

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
    private readonly sharing: NamespaceSharing,
  ) {
    this.blobField = schema.blob;
    this.versioned = schema.versioned === true;
  }

  private requireBackend(): StorageBackend {
    return requireAvailableBackend(this.backend, "storage");
  }

  private assertReadable(): void {
    this.sharing.assertLocalAccess(this.ns, "read");
  }

  private assertWritable(): void {
    assertWritableNamespace(this.mode, this.ns, "storage");
    this.sharing.assertLocalAccess(this.ns, "readwrite");
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

  /** Declared cast for a sort field. Range predicates infer theirs from the
   * operand; `orderBy` has none, so it comes from the schema (default text). */
  private fieldType(field: string): OrderType {
    const declared = (this.schema.fieldTypes as Record<string, OrderType> | undefined)?.[field];
    return declared ?? "text";
  }

  private toBackendQuery(q: Query<T>): BackendQuery {
    const orderField = typeof q.orderBy === "string" ? q.orderBy : q.orderBy?.field;
    // The blob field is stored out-of-line and is absent from the queryable
    // metadata, so filtering/ordering by it can never match. Fail loud instead
    // of silently returning an empty set.
    if (this.blobField) {
      if (q.where && this.blobField in q.where) {
        throw storageError("invalid_input", `cannot filter on blob field "${this.blobField}"`);
      }
      if (orderField === this.blobField) {
        throw storageError("invalid_input", `cannot order by blob field "${this.blobField}"`);
      }
    }
    const out: BackendQuery = {};
    const where = compileWhere<T>(q.where);
    if (where.length > 0) out.where = where;
    if (orderField) {
      const explicit = typeof q.orderBy === "string" ? undefined : q.orderBy;
      out.orderBy = {
        field: orderField,
        type: explicit?.type ?? this.fieldType(orderField),
        dir: explicit?.dir ?? q.order ?? "asc",
      };
    }
    if (q.limit !== undefined) out.limit = q.limit;
    if (q.after !== undefined) out.after = q.after;
    return out;
  }

  /**
   * Runs `run()` under an abort guard: pre-checks `signal` (redundant with the
   * caller's own pre-check, but this is also what re-checks the signal at the
   * top of every pagination loop iteration), then on failure prefers the
   * abort reason over whatever error the interrupted call itself raised.
   */
  private async abortable<R>(
    signal: AbortSignal | undefined,
    what: string,
    run: () => Promise<R>,
  ): Promise<R> {
    throwIfAborted(signal, what);
    try {
      return await run();
    } catch (err) {
      throwIfAborted(signal, what, err);
      throw err;
    }
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

  async get(id: string, opts: StorageCallOptions = {}): Promise<T | null> {
    this.assertReadable();
    const signal = opts.signal;
    const what = `get on "${this.name}"`;
    const backend = this.requireBackend();
    throwIfAborted(signal, what);
    await this.ensure(backend);
    const call = signal ? { signal } : undefined;
    const rec = await this.abortable(signal, what, () => backend.get(this.ns, this.name, id, call));
    if (!rec) return null;
    const blob =
      this.blobField && rec.hasBlob
        ? await this.abortable(signal, what, () => backend.readBlob(this.ns, this.name, id, call))
        : null;
    return this.hydrate(rec, blob);
  }

  async query(q: Query<T> = {}): Promise<T[]> {
    this.assertReadable();
    const signal = q.signal;
    const what = `query on "${this.name}"`;
    const backend = this.requireBackend();
    throwIfAborted(signal, what);
    await this.ensure(backend);
    const bq = this.toBackendQuery(q);
    const call = signal ? { signal } : undefined;
    // The wire query is PAGED (keyset), but `query()`'s contract is "every
    // match". Walk the cursor here so callers keep the simple array they had
    // before the pushdown — a bare `query()` must not silently truncate at the
    // server's default page size.
    const want = q.limit;
    const rows: BackendRecord[] = [];
    let after = bq.after;
    let seen: string | undefined;
    for (let pages = 0; ; pages++) {
      const remaining = want === undefined ? MAX_PAGE : want - rows.length;
      if (remaining <= 0) break;
      // Re-checked at the top of every loop iteration via `abortable`'s
      // pre-check — this is what stops the walk BETWEEN pages, not just before
      // the first one.
      const page = await this.abortable(signal, what, () =>
        backend.query(
          this.ns,
          this.name,
          {
            ...bq,
            limit: Math.min(MAX_PAGE, remaining),
            ...(after === undefined ? {} : { after }),
          },
          call,
        ),
      );
      rows.push(...page.records);
      if (!page.nextCursor) break;
      if (want !== undefined && rows.length >= want) break;
      // A cursor that fails to advance would spin forever.
      if (page.nextCursor === seen) break;
      seen = page.nextCursor;
      after = page.nextCursor;
      if (pages + 1 >= MAX_SCAN_PAGES) {
        throw storageError(
          "invalid_input",
          `query on "${this.name}" exceeded ${MAX_SCAN_PAGES * MAX_PAGE} rows — pass a limit, narrow the where, or page with page()/after`,
        );
      }
    }
    // Blob field is intentionally omitted from scans — use get() for it.
    const out = want === undefined ? rows : rows.slice(0, want);
    return out.map((r) => ({ ...r.metadata }) as T);
  }

  async page(q: Query<T> = {}): Promise<Page<T>> {
    this.assertReadable();
    const signal = q.signal;
    const what = `page on "${this.name}"`;
    const backend = this.requireBackend();
    throwIfAborted(signal, what);
    await this.ensure(backend);
    const call = signal ? { signal } : undefined;
    const { records, nextCursor } = await this.abortable(signal, what, () =>
      backend.query(this.ns, this.name, this.toBackendQuery(q), call),
    );
    return {
      items: records.map((r) => ({ ...r.metadata }) as T),
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async count(q: Query<T> = {}): Promise<number> {
    this.assertReadable();
    const signal = q.signal;
    const what = `count on "${this.name}"`;
    const backend = this.requireBackend();
    throwIfAborted(signal, what);
    await this.ensure(backend);
    const bq = this.toBackendQuery(q);
    const call = signal ? { signal } : undefined;
    return this.abortable(signal, what, () =>
      backend.count(this.ns, this.name, bq.where ? { where: bq.where } : {}, call),
    );
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
    this.assertReadable();
    const backend = this.requireBackend();
    await this.ensure(backend);
    return backend.readBlob(this.ns, this.name, id);
  }

  async versions(id: string): Promise<VersionMeta[]> {
    this.assertReadable();
    const backend = this.requireBackend();
    await this.ensure(backend);
    const list = await backend.listVersions(this.ns, this.name, id);
    return list.map((v) => ({ version: v.version, createdAt: v.createdAt }));
  }

  async getVersion(id: string, version: number): Promise<T | null> {
    this.assertReadable();
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
    private readonly sharing: NamespaceSharing,
  ) {}

  collection<T extends StorageRecord>(name: string, schema: CollectionSchema<T>): Collection<T> {
    return new CollectionImpl<T>(this.backend, this.id, name, schema, this.mode, this.sharing);
  }
}

/**
 * App-namespaced storage. Reached as `sdk.storage`.
 *
 * `namespace()` opens the calling app's own (read-write) namespace; the
 * namespace id is derived from the client's `appId` (host-stamped per app).
 * `namespace("other-app")` opens another app's data and requires a grant
 * (`sdk.storage.grants.grant`). Local backends enforce grants here;
 * cloud backends let unified-api enforce and map `storage_not_granted`.
 */
export class Storage {
  // Shared resolution machinery: injected backend wins → server-capable clients
  // get a lazily-built (cached) CloudStorageBackend → null (Supabase-only;
  // there is no local browser IndexedDB fallback).
  private readonly resolver: BackendResolver<StorageBackend>;
  #sharing?: NamespaceSharing;

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

  /**
   * Grant CRUD for this app's storage namespace. Any marketplace app can
   * expose its collections to other apps or authenticated agents without
   * baking domain types into the SDK.
   */
  get grants(): NamespaceSharing {
    if (!this.#sharing) {
      this.#sharing = new NamespaceSharing({
        resource: "storage",
        client: this.client,
        local: this.localGrantStore(),
        ownNs: () => this.client.appId,
      });
    }
    return this.#sharing;
  }

  /** Open a namespace handle (defaults to the calling app's own namespace). */
  namespace(appId?: string, opts: NamespaceOptions = {}): Namespace {
    const { id, mode } = deriveNamespace(this.client.appId, appId, opts.mode);
    const sharing = this.grants;
    sharing.assertLocalAccess(id, mode);
    return new NamespaceImpl(this.resolver.resolve(), id, mode, sharing);
  }

  private localGrantStore() {
    if (this.client.grantStore) return this.client.grantStore;
    const backend = this.client.storageBackend;
    return backend instanceof MemoryBackend ? backend.grants : null;
  }
}

// Public types + the swappable backend contract for `sdk.storage` — the
// local-first, app-namespaced storage resource. See STORAGE-SPEC.md.
//
// Two layers live here:
//   1. The PUBLIC, typed surface (`Collection<T>`, `Namespace`, `CollectionSchema`,
//      `Query`) the app programs against. The typing is compile-time only — a
//      thin facade casts untyped backend records to `T`.
//   2. The untyped `StorageBackend` contract every runtime implements (browser
//      IndexedDB here; an injected SQLite+files backend in the Tauri host). The
//      backend never sees `T` — it stores a collection name, a JSON-ish metadata
//      bag, and optional blob bytes.

/** A record an app stores. Fields must be JSON-serialisable (the blob field aside). */
export type StorageRecord = Record<string, unknown>;

/**
 * How a blob field's value was encoded, so `get()` reconstructs the ORIGINAL
 * type: a `string` (utf8), a `Uint8Array` (binary), or an `ArrayBuffer`
 * (arraybuffer). The distinction matters — a value put as an `ArrayBuffer` must
 * not silently read back as a `Uint8Array` (they are not API-substitutable).
 */
export type BlobEncoding = "utf8" | "binary" | "arraybuffer";

/** Read-only namespaces reject writes; read-write is the default for an app's own data. */
export type NamespaceMode = "read" | "readwrite";

/** Sort direction for `Query.orderBy`. */
export type SortOrder = "asc" | "desc";

/**
 * Declarative schema for a typed collection. The SDK derives the backend's
 * index columns and the file/blob split from this — no per-app table is baked
 * into the SDK, so the same primitive serves any app.
 */
export interface CollectionSchema<T> {
  /** Field that is the record's primary key. Its value is coerced to a string id. */
  key: keyof T & string;
  /** Fields the backend should index for `query()` filtering/ordering. */
  indexes?: ReadonlyArray<keyof T & string>;
  /**
   * One field stored as a FILE/blob rather than inline in the index. Its value
   * must be a string, `Uint8Array`, or `ArrayBuffer`. `query()` omits it (cheap
   * scans); `get()` / `getVersion()` rehydrate it; `blob()` fetches it lazily.
   */
  blob?: keyof T & string;
  /** Keep per-write version history (enables `versions()` / `getVersion()` / `revert()`). */
  versioned?: boolean;
}

/** A filter/sort/paginate query over a collection. */
export interface Query<T> {
  /** Equality match on the given fields (ANDed together). */
  where?: Partial<T>;
  /** Field to order by. Defaults to insertion/update order when omitted. */
  orderBy?: keyof T & string;
  /** Order direction. Defaults to `"asc"`. */
  order?: SortOrder;
  /** Max rows to return. */
  limit?: number;
  /** Rows to skip (applied before `limit`). */
  offset?: number;
}

/** Result of a write — the stable id, the new version number, and the write time. */
export interface StoredRef {
  id: string;
  version: number;
  updatedAt: number;
}

/** A single version entry (metadata only — no blob bytes) for history listing. */
export interface VersionMeta {
  version: number;
  createdAt: number;
}

/**
 * A typed handle to one collection within a namespace. All methods reject with a
 * `UnifiedError` (`storage_unavailable` when no backend is wired,
 * `storage_read_only` when writing through a read-only namespace).
 */
export interface Collection<T> {
  /** Insert or replace by key. Bumps the version (and snapshots, when `versioned`). */
  put(value: T): Promise<StoredRef>;
  /** Full record (including the blob field) by id, or `null` if absent. */
  get(id: string): Promise<T | null>;
  /** Indexed scan. The blob field is OMITTED from results — use `get()` for it. */
  query(q?: Query<T>): Promise<T[]>;
  /** Count rows matching `where` (ignores `limit`/`offset`). */
  count(q?: Query<T>): Promise<number>;
  /** Delete by id (cascades the record's blob + version history). */
  delete(id: string): Promise<boolean>;
  /** Alias of {@link delete} (parity with `files.del`; `delete` is awkward as a method name). */
  del(id: string): Promise<boolean>;
  /** Raw bytes of the blob field, or `null` when there is none. */
  blob(id: string): Promise<Uint8Array | null>;
  /** Version history, newest first. Empty unless the schema is `versioned`. */
  versions(id: string): Promise<VersionMeta[]>;
  /** A full historical record at a specific version, or `null`. */
  getVersion(id: string, version: number): Promise<T | null>;
  /** Restore a prior version as a new head (non-destructive). */
  revert(id: string, version: number): Promise<StoredRef>;
}

export interface NamespaceOptions {
  /** Access mode. Own-namespace defaults to `"readwrite"`; cross-app defaults to `"read"`. */
  mode?: NamespaceMode;
}

/** A namespace handle — the unit of per-app isolation. */
export interface Namespace {
  /** The resolved namespace id (the calling app's id, or a cross-app target). */
  readonly id: string;
  readonly mode: NamespaceMode;
  /** Open a typed collection within this namespace. */
  collection<T extends StorageRecord>(name: string, schema: CollectionSchema<T>): Collection<T>;
}

// ─── Backend contract (untyped, swappable) ──────────────────────────────────

/** A stored record as the backend returns it — metadata only, no blob bytes. */
export interface BackendRecord {
  id: string;
  metadata: Record<string, unknown>;
  version: number;
  createdAt: number;
  updatedAt: number;
  hasBlob: boolean;
  blobEncoding?: BlobEncoding;
}

/** A version-history entry as the backend returns it. */
export interface BackendVersion {
  version: number;
  createdAt: number;
  hasBlob: boolean;
}

/** A write request handed to the backend. */
export interface PutReq {
  ns: string;
  collection: string;
  id: string;
  metadata: Record<string, unknown>;
  versioned: boolean;
  /** The blob field's bytes, when the schema declares one and the value is set. */
  blob?: Uint8Array;
  blobEncoding?: BlobEncoding;
}

/** The backend-level query (field names are plain strings — the facade resolves them from `T`). */
export interface BackendQuery {
  where?: Record<string, unknown>;
  orderBy?: string;
  order?: SortOrder;
  limit?: number;
  offset?: number;
}

/** Collection shape the backend may use to provision indexes / a blob split. */
export interface BackendSchema {
  key: string;
  indexes: string[];
  blobField?: string;
  versioned: boolean;
}

/**
 * The storage transport. The browser ships an IndexedDB implementation; the
 * Tauri host injects a SQLite+files one via `UnifiedAIOptions.storage`. The
 * backend is untyped and trust-agnostic: in the host, the calling app's
 * identity (`ns`) is re-derived and authorized at the IPC boundary, not taken
 * on faith from these arguments.
 */
export interface StorageBackend {
  /** Short identifier, e.g. `"indexeddb"` / `"tauri-sqlite"` — for diagnostics. */
  readonly name: string;
  /** Whether the backend can operate in the current runtime right now. */
  available(): boolean;
  /** Provision a collection (idempotent). May be a no-op for schemaless backends. */
  ensureCollection(ns: string, collection: string, schema: BackendSchema): Promise<void>;
  put(req: PutReq): Promise<StoredRef>;
  get(ns: string, collection: string, id: string): Promise<BackendRecord | null>;
  query(ns: string, collection: string, q: BackendQuery): Promise<BackendRecord[]>;
  count(ns: string, collection: string, q: BackendQuery): Promise<number>;
  delete(ns: string, collection: string, id: string): Promise<boolean>;
  readBlob(ns: string, collection: string, id: string): Promise<Uint8Array | null>;
  listVersions(ns: string, collection: string, id: string): Promise<BackendVersion[]>;
  getVersion(
    ns: string,
    collection: string,
    id: string,
    version: number,
  ): Promise<BackendRecord | null>;
  readVersionBlob(
    ns: string,
    collection: string,
    id: string,
    version: number,
  ): Promise<Uint8Array | null>;
  revert(ns: string, collection: string, id: string, version: number): Promise<StoredRef>;
}

// Public types + the swappable backend contract for `sdk.storage` — the
// local-first, app-namespaced storage resource. See STORAGE-SPEC.md.
//
// Two layers live here:
//   1. The PUBLIC, typed surface (`Collection<T>`, `Namespace`, `CollectionSchema`,
//      `Query`) the app programs against. The typing is compile-time only — a
//      thin facade casts untyped backend records to `T`.
//   2. The untyped `StorageBackend` contract every runtime implements (the
//      server-backed Cloud backend against unified-api → Supabase; or a
//      host-injected one). The backend never sees `T` — it stores a collection
//      name, a JSON-ish metadata bag, and optional blob bytes.

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
   * Which fields hold NUMBERS, for `orderBy`.
   *
   * Ordering is pushed into the server, which extracts a metadata field either
   * as text (`metadata->>f`, lexicographic — `"10" < "9"`) or as JSON
   * (`metadata->f`, numeric). Range predicates infer this from the operand at
   * query time, but `orderBy` has no operand to infer from, so a numeric sort
   * field must be declared here or it will sort as text. Unlisted fields
   * default to `"text"`.
   *
   * Epoch-millisecond timestamps are the common case where text and numeric
   * order coincide (fixed digit width) — small integers like counters, ranks,
   * and sequence numbers are the case that silently sorts wrong. Declare them.
   */
  fieldTypes?: { readonly [K in keyof T & string]?: OrderType };
  /**
   * One field stored as a FILE/blob rather than inline in the index. Its value
   * must be a string, `Uint8Array`, or `ArrayBuffer`. `query()` omits it (cheap
   * scans); `get()` / `getVersion()` rehydrate it; `blob()` fetches it lazily.
   */
  blob?: keyof T & string;
  /** Keep per-write version history (enables `versions()` / `getVersion()` / `revert()`). */
  versioned?: boolean;
}

/** How a metadata field is extracted for comparison/ordering: as text
 * (lexicographic) or as a JSON number (numeric). */
export type OrderType = "text" | "number";

/**
 * The operators a `where` field may use. Multiple operators on one field are
 * ANDed, so `{ gte: 1, lte: 5 }` is a closed range.
 *
 * `exists` is the only operator an ABSENT field can satisfy — every other
 * operator follows SQL three-valued logic and skips rows whose key is missing
 * (including `neq`). Since the server strips nulls on write, "field is null"
 * and "field is absent" are the same state: `{ exists: false }`.
 */
export interface PredicateOps<V> {
  /** Equal (compared as text server-side, so `5` matches a stored `5`). */
  eq?: V;
  /** Not equal. Rows MISSING the field are excluded (SQL semantics). */
  neq?: V;
  /** One of — max 50 values. */
  in?: readonly V[];
  gt?: V;
  gte?: V;
  lt?: V;
  lte?: V;
  /** `true` = the field has a value; `false` = it is absent (or was null). */
  exists?: boolean;
  /**
   * Full-text search. Valid ONLY on a field named `searchText` — that is the
   * one field with a full-text index server-side. Accepts websearch syntax
   * (`terms`, `"a phrase"`, `-excluded`).
   *
   * Checked against `NonNullable<V>`, not `V` directly: `V extends string ? …`
   * is a naked-type-parameter conditional, so TypeScript distributes it over
   * `V`'s union members. For an OPTIONAL field (`V = string | undefined`), the
   * `undefined` branch evaluates to `never` and the distributed union
   * collapses to `string | never` in principle — but in practice the
   * distribution interacts badly with how `Predicate<T[K]>` is instantiated
   * through a mapped type (`T[K]` is an indexed access, not a bare type
   * parameter), which made `match` unusable on any optional string field
   * (forcing callers into an `as unknown as Partial<...>` cast just to use
   * it). Stripping null/undefined FIRST makes the check operate on a plain
   * `string`, sidestepping the distribution entirely.
   */
  match?: NonNullable<V> extends string ? string : never;
}

/** A `where` value: a bare value (equality shorthand) or an operator object. */
export type Predicate<V> = V | PredicateOps<V>;

/** Explicit order spec — use this form to override the field's declared cast. */
export interface OrderBy<T> {
  field: keyof T & string;
  /** Overrides `CollectionSchema.fieldTypes`. Defaults to `"text"`. */
  type?: OrderType;
  dir?: SortOrder;
}

/**
 * Per-call options that are purely client-side and never serialized onto the
 * wire (unlike `Query`, which is lowered into the JSON-serialized
 * `BackendQuery`). Currently just `signal`: aborting cancels the in-flight
 * request and stops `query()`'s page walk between pages. An aborted call
 * rejects with a `UnifiedError` whose `code` is `"aborted"`; `signal.reason`
 * is preserved as the error's `cause`.
 */
export interface StorageCallOptions {
  signal?: AbortSignal;
}

/** A filter/sort/paginate query over a collection. */
export interface Query<T> {
  /**
   * Filter (ANDed across fields). A bare value is equality; an operator object
   * expresses ranges, sets, existence, and full-text — see {@link PredicateOps}.
   * A `null`/`undefined` value means "field has no value" (`{ exists: false }`).
   */
  where?: { [K in keyof T]?: Predicate<T[K]> };
  /** Field to order by (id-ascending is always the tiebreak). */
  orderBy?: (keyof T & string) | OrderBy<T>;
  /** Order direction for the string `orderBy` form. Defaults to `"asc"`. */
  order?: SortOrder;
  /** Max rows to return. `query()` fetches every match when omitted. */
  limit?: number;
  /**
   * Opaque keyset cursor from a previous `page()` — resume after that row.
   * Pass the previous `nextCursor` verbatim; never construct one by hand.
   * (Replaces the old `offset`, which the pushed-down query cannot express.)
   */
  after?: string;
  /**
   * Client-side only — never copied into `BackendQuery`. Aborting cancels the
   * in-flight request and (for `query()`) stops the page walk between pages.
   */
  signal?: AbortSignal;
}

/** One page of results plus the cursor to continue from, if any. */
export interface Page<T> {
  items: T[];
  /** Present iff more rows match. Pass as `Query.after` for the next page. */
  nextCursor?: string;
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
  get(id: string, opts?: StorageCallOptions): Promise<T | null>;
  /**
   * Indexed scan. The blob field is OMITTED from results — use `get()` for it.
   * Returns EVERY match, transparently following the server's keyset pages,
   * unless `limit` caps it. Use {@link page} when you want to drive paging.
   */
  query(q?: Query<T>): Promise<T[]>;
  /** One page of {@link query}, plus the cursor to continue from. */
  page(q?: Query<T>): Promise<Page<T>>;
  /** Count rows matching `where` (ignores `limit`/`orderBy`/`after`). */
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

/** Comparison operators on the wire. */
export type WhereOp = "eq" | "neq" | "in" | "gt" | "gte" | "lt" | "lte" | "exists" | "match";

/** One ANDed filter clause on a single metadata field. This is the flat shape
 * unified-api's `/query-v2` consumes — the facade lowers `Query.where` to it. */
export interface BackendWhere {
  field: string;
  op: WhereOp;
  /** Scalar for most ops; an array for `in`; a boolean for `exists`. */
  value?: unknown;
  /** Cast for range ops only (`gt`/`gte`/`lt`/`lte`). Defaults to `"text"`. */
  type?: OrderType;
}

/**
 * The backend-level query (field names are plain strings — the facade resolves
 * them from `T`). Mirrors unified-api's `QueryV2` exactly: predicates are
 * pushed into SQL and pagination is a keyset cursor, never an offset.
 *
 * This shape is `JSON.stringify`'d verbatim into the POST body — nothing
 * non-JSON-serializable may be added here (an `AbortSignal` would serialize to
 * `{}`, silent junk on the wire). A caller's abort signal travels via the
 * separate `StorageCallOptions` channel instead; never add `signal` here.
 */
export interface BackendQuery {
  where?: BackendWhere[];
  orderBy?: { field: string; type?: OrderType; dir?: SortOrder };
  /** Backend default is 100, clamped to 1000. */
  limit?: number;
  after?: string;
}

/** One page of backend records plus the cursor to resume from. */
export interface BackendPage {
  records: BackendRecord[];
  /** Present iff more rows match. */
  nextCursor?: string;
}

/** Collection shape the backend may use to provision indexes / a blob split. */
export interface BackendSchema {
  key: string;
  indexes: string[];
  blobField?: string;
  versioned: boolean;
}

/**
 * The storage transport. The SDK ships the server-backed Cloud backend (against
 * unified-api → Supabase); a host may inject its own via `UnifiedAIOptions.storage`.
 * The backend is untyped and trust-agnostic: in the host, the calling app's
 * identity (`ns`) is re-derived and authorized at the IPC boundary, not taken
 * on faith from these arguments.
 */
export interface StorageBackend {
  /** Short identifier, e.g. `"cloud"` / `"memory"` — for diagnostics. */
  readonly name: string;
  /** Whether the backend can operate in the current runtime right now. */
  available(): boolean;
  /** Provision a collection (idempotent). May be a no-op for schemaless backends. */
  ensureCollection(ns: string, collection: string, schema: BackendSchema): Promise<void>;
  put(req: PutReq): Promise<StoredRef>;
  get(
    ns: string,
    collection: string,
    id: string,
    opts?: StorageCallOptions,
  ): Promise<BackendRecord | null>;
  /** One keyset page. The facade loops on `nextCursor` for unbounded scans. */
  query(
    ns: string,
    collection: string,
    q: BackendQuery,
    opts?: StorageCallOptions,
  ): Promise<BackendPage>;
  /** Rows matching `q.where` (`limit`/`orderBy`/`after` are ignored). */
  count(
    ns: string,
    collection: string,
    q: BackendQuery,
    opts?: StorageCallOptions,
  ): Promise<number>;
  delete(ns: string, collection: string, id: string): Promise<boolean>;
  readBlob(
    ns: string,
    collection: string,
    id: string,
    opts?: StorageCallOptions,
  ): Promise<Uint8Array | null>;
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

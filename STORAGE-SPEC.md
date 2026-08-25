# `sdk.storage` — Local-First Storage for UnifiedApp Apps

> **⚠️ Superseded (2026-06-27):** `sdk.storage` and `sdk.fs` are now **Supabase-only** (server-backed Cloud
> backend via unified-api). The local browser fallbacks — `IndexedDbBackend` (storage) and `OpfsBackend` (fs) —
> have been **removed**: with no token and no host-injected backend, `sdk.storage`/`sdk.fs` report *unavailable*
> (there is no offline/local store). `MemoryBackend` remains for tests/injection only. The IndexedDB/OPFS
> references below are retained as historical design context and no longer describe the shipped code.
>
> **Status (corrected 2026-07-15):** Phase 1 (IndexedDB backend + design-app migration) was implemented and later
> **removed** (see banner). **Phase 2 was never implemented** — no Tauri SQLite/file-blob backend exists in
> UnifiedApp; `src-tauri` has no storage or fs modules. What shipped instead is the Supabase-only Cloud backend
> (a variant of Phase 3). A native desktop cache is planned separately (Phase 0 sync engine, 2026-07) ·
> **Date:** 2026-06-22 · **Owner:** platform
> **Scope:** uni-sdk surface + `StorageBackend` contract + host (Tauri) backend + design-app migration.
> **Decisions locked:** local-only (no cloud sync yet) · new `sdk.storage` resource (not an extension of `sdk.files`) ·
> generic **typed collections** (`collection<T>`), not app-specific resources baked into the SDK · isolation by default,
> capability-gated cross-app sharing · files-on-disk + SQLite index backend.

---

## 1. Goals & non-goals

### Goals
- **One uniform storage API for every app** in the UnifiedApp marketplace — design-app, docs, and arbitrary
  third-party apps — reached through the same `@unifiedai/sdk` client the app already uses for models.
- **Local-first & optimized:** blobs on disk, a SQLite index for "fetch the right files for the right purpose,"
  instant reads/writes, fully offline.
- **Typed developer experience** without welding any one app's domain into the shared SDK.
- **Backend-agnostic:** the identical app code runs on the optimized Tauri backend (desktop) and on an IndexedDB
  fallback (web / standalone dev).
- **Marketplace-safe:** an app sees only its own data by default; cross-app reads are an explicit, user-granted
  capability, enforced in the trusted host — never in app JS.

### Non-goals (this phase)
- **Cloud sync / cross-device.** Deferred. The design keeps a seam for it (a future `CloudBackend` against
  unified-api files), but Phases 1–2 are local-only. No `unified-api` / `unified-db` changes.
- **Encryption at rest, quota/eviction policy, full-text search, rich query predicates** beyond indexed equality +
  ordering. All listed in §13 as follow-ups.
- **Real-time multi-writer conflict resolution.** Single-device, single-writer assumption for now.

---

## 2. Architecture

```
              ┌──────────────────────────────────────────────────────────┐
   every app  │   sdk.storage  —  uniform, typed resource surface         │   apps only ever see this
              │   .namespace(appId?, opts).collection<T>(name, schema)    │
              └───────────────────────────────┬──────────────────────────┘
                                              │  StorageBackend (untyped: collection + JSON + bytes)
        ┌──────────────────────┬──────────────┴───────────────┬──────────────────────┐
        ▼                      ▼                              ▼                       ▼
  TauriBackend           IndexedDbBackend                CloudBackend            MemoryBackend
  SQLite + files         (web / Quasar /                 (FUTURE: unified-api    (tests)
  via Tauri IPC → Rust   standalone dev)                  files; sync)
  ──── injected by host at SDK construction ────      ──── deferred ────
```

Two layers, deliberately separated:

1. **Typed facade (`Collection<T>`)** — compile-time typing only. Sugar over the backend; casts untyped records to
   `T`. This is where the "typed" DX lives and where index columns are *derived from the declared schema*.
2. **`StorageBackend`** — the untyped, swappable seam (collection name + JSON metadata + optional blob bytes). Each
   runtime provides one. This mirrors how uni-sdk already swaps `fetch` and auth mode (trusted-token vs OAuth).

### Why this shape
uni-sdk's client already attaches resources as fields (`this.files`, `this.chat`…) and already takes pluggable
infrastructure via `UnifiedAIOptions` (custom `fetch`, two auth modes). `storage` is one more resource field; the
backend is one more injected dependency. The host (UnifiedApp) constructs the per-app SDK and injects the Tauri
backend + the app's stamped identity — exactly where it already injects the token.

---

## 3. The `sdk.storage` surface

### 3.1 Entry & namespace resolution

```ts
interface Storage {
  /** True when a backend is wired (Tauri host or browser IndexedDB). */
  available(): boolean;

  /**
   * Open a namespace handle.
   *   - namespace()            → the CALLING APP's own namespace (identity stamped by the host; the app cannot
   *                              spoof another's). Read+write.
   *   - namespace("docs", …)   → another app's namespace. Requires a granted capability (see §6); the host
   *                              rejects ungranted access. Default mode "read".
   */
  namespace(appId?: string, opts?: { mode?: "read" | "readwrite" }): Namespace;
}
```

`appId` for the app's *own* data is never passed by the app — `namespace()` with no argument resolves to the
host-stamped identity. Passing an `appId` is only for *cross-app* reference and is capability-checked.

### 3.2 Declaring a typed collection

```ts
interface Namespace {
  collection<T extends Record<string, unknown>>(name: string, schema: CollectionSchema<T>): Collection<T>;
}

interface CollectionSchema<T> {
  /** Field that is the record's primary key. Required. */
  key: keyof T;
  /** Fields materialized as SQLite index columns for `query()` ordering/filtering. */
  indexes?: (keyof T)[];
  /**
   * One field stored as a FILE/blob instead of inline in the index. Its value must be a `string`,
   * `Uint8Array`, or `ArrayBuffer` — and round-trips back as the SAME type via `get()`. `query()` omits it
   * (cheap scans) and rejects filtering/ordering by it; `blob()` fetches its raw bytes lazily.
   */
  blob?: keyof T;
  /** Keep per-write version history (see §3.4). Replaces hand-rolled "fileVersions"-style stores. */
  versioned?: boolean;
}
```

The schema is declarative metadata: the SQLite index columns and the on-disk blob split are *derived* from it, so
uni-sdk stays domain-agnostic while the app gets full typing.

### 3.3 Collection operations

```ts
interface Collection<T> {
  put(value: T): Promise<StoredRef>;            // insert or replace by key; bumps version if versioned
  get(id: string, opts?: StorageCallOptions): Promise<T | null>;  // full record incl. blob field
  query(q?: Query<T>): Promise<T[]>;            // indexed scan; blob field omitted; follows cursor pages
  page(q?: Query<T>): Promise<Page<T>>;        // one keyset page + nextCursor
  count(q?: Query<T>): Promise<number>;
  delete(id: string): Promise<boolean>;
  del(id: string): Promise<boolean>;            // alias of delete (parity with files.del)
  blob(id: string): Promise<Uint8Array | null>; // lazily fetch the blob field's bytes

  // present only when schema.versioned === true
  versions(id: string): Promise<VersionMeta[]>;          // metadata only (cheap history list)
  getVersion(id: string, version: number): Promise<T | null>;  // full historical record, lazily
  revert(id: string, version: number): Promise<StoredRef>;
}

type Predicate<V> = V | PredicateOps<V>;   // bare value = equality shorthand

interface PredicateOps<V> {
  eq?: V; neq?: V; in?: readonly V[];       // compared as TEXT server-side
  gt?: V; gte?: V; lt?: V; lte?: V;         // cast inferred from the operand
  exists?: boolean;                          // true = has a value, false = absent
  match?: string;                            // full-text; ONLY on `searchText`
}

interface Query<T> {
  where?: { [K in keyof T]?: Predicate<T[K]> };  // ANDed; multiple ops on a field also AND
  orderBy?: (keyof T & string) | { field: keyof T & string; type?: "text" | "number"; dir?: "asc" | "desc" };
  order?: "asc" | "desc";        // default "asc" (string orderBy form)
  limit?: number;
  after?: string;                // opaque keyset cursor (replaces `offset`)
  signal?: AbortSignal;          // client-side only; never sent to the server (see StorageCallOptions)
}

interface Page<T> { items: T[]; nextCursor?: string }

/** Per-call options that are purely client-side and never serialized onto the wire. */
interface StorageCallOptions { signal?: AbortSignal }

interface StoredRef { id: string; version: number; updatedAt: number }
interface VersionMeta { version: number; createdAt: number }
```

Notes:
- **`query()` never reads blobs** — it touches the index only. That is the "db for fetching the right files for the
  right purpose": list/scan from the index, then pull the file with `get()`/`blob()` only for the chosen record.
- **History is metadata-only by default.** `versions(id)` returns just `{ version, createdAt }` (newest-first) so
  listing history never loads every historical blob; `getVersion(id, n)` fetches a specific version's full record
  (incl. blob) on demand.
- **Blob fields are not queryable.** `where`/`orderBy` on the field declared as `schema.blob` throws
  `invalid_input` (it's stored out-of-line, so it could never match).
- **Indexed vs non-indexed.** The in-process backends (IndexedDB / Memory) filter and order over *any* metadata
  field. The Tauri SQLite backend can only filter/order by columns materialized from `schema.indexes`, so for
  **cross-backend portability, query/order only on indexed fields** — declare them in `schema.indexes`. Against the
  cloud backend `schema.indexes` is still inert (`ensureCollection` is a no-op — the server store is schemaless);
  server-side expression indexes are provisioned by unified-db migrations, not by the SDK.
- **Predicates are pushed into SQL.** `query()` compiles to unified-api's `/query-v2` and `count()` to its sibling
  `/count-v2`, which evaluate `where` as the SAME PostgREST filters instead of selecting the whole collection and
  filtering it in JS. The consequences are load-bearing:
  - **SQL, not JS, semantics.** `eq`/`neq`/`in` compare the field's *text* extraction, so `where: { n: 5 }` matches
    a stored `5`. Rows **missing** the field satisfy no operator except `exists: false` — including `neq`.
  - **`null` means absent.** The write path runs `jsonb_strip_nulls`, so a stored `null` is an absent key.
    `where: { x: null }` therefore compiles to `{ exists: false }` (it used to silently match nothing).
  - **Numeric vs text ordering.** Range ops infer their cast from the operand. `orderBy` cannot — declare numeric
    sort fields in `schema.fieldTypes`, or `10` sorts before `9`. Epoch-ms timestamps happen to sort the same
    either way; counters, ranks, and sequence numbers do not.
  - **`match` only works on `searchText`** — the one field with a generated tsvector column server-side.
  - **Pagination is a keyset cursor, not an offset.** `query()` transparently follows `nextCursor` so it still
    returns every match; `page()` exposes the cursor for real paging. `offset` is gone — a pushed-down query
    cannot express it. The effective order is a strict total order on `(has-the-field, order value, id)` — rows
    missing the `orderBy` field form a contiguous NULL block, sorted last ascending / first descending (Postgres'
    default), with `id` ascending as the tiebreak throughout. A page boundary landing inside that block still
    resumes correctly: the cursor a page ends on simply omits the order value, which the next page reads as
    "resume from the null block," not as an error. A full walk therefore visits every matching row exactly once
    and terminates, no matter how sparse the field is.
  - **`count()` is one request, not a walk.** `/count-v2` shares `/query-v2`'s exact where-compilation — every
    operator, including `match`, counts consistently with what `query()` would return — but it answers with a
    single `{ count }` round trip instead of paging through matches. It **rejects `limit` and `after`** with a 400
    `unsupported_query` (a page-scoped count would be a wrong answer dressed as a right one); `orderBy` is accepted
    and ignored, since ordering is meaningless for a count.

### 3.4 Versioning

When `versioned: true`, each `put` appends a version and advances the head. `versions(id)` lists them newest-first
(metadata only); `getVersion(id, n)` returns version `n`'s full value; `revert(id, n)` writes version `n` as a new
head (non-destructive), throwing `not_found` if that version doesn't exist. The Tauri backend **content-addresses**
blobs (§7) so unchanged blobs are shared across versions; the IndexedDB fallback stores a blob snapshot per version.

---

## 4. The `StorageBackend` contract (the swappable seam)

Untyped and minimal. Each runtime implements it; the typed `Collection<T>` is a thin facade over it.

```ts
interface StorageBackend {
  readonly name: string;
  available(): boolean;
  ensureCollection(ns: string, collection: string, schema: BackendSchema): Promise<void>;  // idempotent
  put(req: PutReq): Promise<StoredRef>;
  get(ns: string, collection: string, id: string, opts?: StorageCallOptions): Promise<BackendRecord | null>;
  query(ns: string, collection: string, q: BackendQuery, opts?: StorageCallOptions): Promise<BackendPage>;  // { records, nextCursor? }
  count(ns: string, collection: string, q: BackendQuery, opts?: StorageCallOptions): Promise<number>;
  delete(ns: string, collection: string, id: string): Promise<boolean>;
  readBlob(ns: string, collection: string, id: string, opts?: StorageCallOptions): Promise<Uint8Array | null>;
  listVersions(ns: string, collection: string, id: string): Promise<BackendVersion[]>;
  getVersion(ns: string, collection: string, id: string, version: number): Promise<BackendRecord | null>;
  readVersionBlob(ns: string, collection: string, id: string, version: number): Promise<Uint8Array | null>;
  revert(ns: string, collection: string, id: string, version: number): Promise<StoredRef>;
}

interface PutReq {
  ns: string; collection: string; id: string;
  metadata: Record<string, unknown>;  // all non-blob fields (JSON-serialisable)
  versioned: boolean;
  blob?: Uint8Array;                   // the blob field's bytes, if the schema declares one
  blobEncoding?: "utf8" | "binary" | "arraybuffer";  // so get() reconstructs the original type
}
interface BackendRecord {
  id: string; metadata: Record<string, unknown>;
  version: number; createdAt: number; updatedAt: number;
  hasBlob: boolean; blobEncoding?: "utf8" | "binary" | "arraybuffer";
}
```

The typed `Collection<T>` is a thin facade: it encodes/decodes the blob field (string→utf8, `Uint8Array`→binary,
`ArrayBuffer`→arraybuffer, reversed on read), strips the blob field out of `metadata`, applies the read-only guard,
and casts records back to `T`. Backends store an opaque metadata bag + blob bytes and never see `T`.

The app's JS is untrusted. **`ns` is resolved/authorized by the host, not taken on faith from the SDK call.** In
Tauri, the IPC boundary into Rust is the trust boundary: Rust re-derives the calling app's identity and enforces
grants (§6) regardless of what the JS passed.

---

## 5. Backends

| Backend | Runtime | Index | Blobs | Selected when |
|---|---|---|---|---|
| **TauriBackend** ✅ | desktop (UnifiedApp2) | SQLite (`rusqlite`, bundled) | content-addressed files in app-data dir | host injects it when `isTauri()` |
| **IndexedDbBackend** | web / Quasar / standalone dev | IndexedDB object stores + indexes | inline in IndexedDB | browser, no host backend |
| **MemoryBackend** | tests | in-map | in-map | explicitly constructed |
| **CloudBackend** | — | unified-api | Supabase Storage | **FUTURE (sync phase)** |

- **IndexedDbBackend ships in uni-sdk's browser-safe core** (zero node deps), so `sdk.storage` works everywhere
  with no host — same API, lesser durability. This is the design-app standalone-dev / web path.
- **TauriBackend** lives in **UnifiedApp** (Rust + `@unified/host-api`), injected into each app's brokered SDK.
- Backend selection is the host's job at SDK construction (a new `storage` option on `UnifiedAIOptions`, analogous
  to `fetch`). If no backend is present, `sdk.storage.available()` is `false` and calls throw `storage_unavailable`
  — the same "feature-detect, degrade gracefully" pattern as OAuth-in-the-browser.

---

## 6. Namespacing, cross-app sharing & security

The marketplace trust model is the hard constraint: third-party apps must not read each other's data by accident or
by malice.

- **Isolation by default.** `namespace()` → the calling app's namespace only. The app cannot widen this.
- **Identity is host-stamped.** The host knows which app a brokered SDK belongs to (same mechanism that scopes
  app-tokens) and stamps that identity on every storage call in the trusted layer. The SDK-level `ns` is a hint;
  **Rust re-derives and enforces.**
- **Cross-app reads are a declared capability.** To read another app's data, the consuming app declares the grant
  in its **manifest** (e.g. `"storage": { "read": ["docs"] }`), the user approves it at install (same surface as
  other app permissions), and only then does `namespace("docs", { mode: "read" })` succeed. Ungranted access →
  `storage_not_granted`.
- **Writes stay owner-only (this phase).** Cross-app *write* grants are intentionally out of scope until a real use
  case appears; sharing is publish/consume, not co-editing.
- **Enforcement location:** the host/Rust backend. Never trust app JS to scope itself.

This satisfies both halves of the requirement: data created in one app *can* be referenced in another, while the
default remains strict per-app separation.

---

## 7. On-disk layout (TauriBackend)

```
{appDataDir}/storage/
  index.sqlite                         # single DB, all namespaces (rows carry `namespace`)
  blobs/
    {sha256[0:2]}/{sha256}             # content-addressed; shared across versions & collections
```

### SQLite (sketch)

```sql
CREATE TABLE objects (
  namespace   TEXT NOT NULL,
  collection  TEXT NOT NULL,
  id          TEXT NOT NULL,
  metadata    TEXT NOT NULL,            -- JSON of non-blob fields
  version     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  blob_hash   TEXT,                     -- nullable; → blobs/{hash}
  PRIMARY KEY (namespace, collection, id)
);

CREATE TABLE object_versions (
  namespace TEXT, collection TEXT, id TEXT, version INTEGER,
  metadata TEXT NOT NULL, blob_hash TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, collection, id, version)
);
```

- **Index columns** declared in `schema.indexes` are materialized as SQLite indexes over
  `json_extract(metadata, '$.field')` (generated columns), so the index set is schema-driven without a hardcoded
  table per app.
- **Content-addressed blobs** (sha-256) give free dedup across versions: reverting or re-saving an unchanged
  artifact costs no extra disk. A refcount (or periodic GC over `blob_hash`) reclaims orphaned blobs on delete.

---

## 8. PROTOCOL.md additions (wire / IPC contract)

`storage` becomes a documented part of the host↔SDK contract:

- **SDK ⇄ host IPC** (Tauri): one command surface — `storage_put`, `storage_get`, `storage_query`,
  `storage_delete`, `storage_count`, `storage_read_blob`, `storage_list_versions`, `storage_revert`,
  `storage_ensure_collection` — each carrying the (host-verified) calling identity. JSON metadata + base64/binary
  blob channel.
- **Capability declaration:** the manifest `storage.read[]` grant shape and its approval lifecycle.
- **Error codes:** `storage_unavailable`, `storage_read_only`, `storage_not_granted`, `not_found`, `invalid_input`
  (emitted today); `conflict` (multi-writer races — Phase 2) and `quota_exceeded` (a future quota phase) are
  reserved and not emitted yet.

(The browser IndexedDB path needs no wire contract — it's in-process.)

---

## 9. Error model

Extend the existing `UnifiedError` hierarchy with the codes above. Conventions:
- `sdk.storage` calls with no backend → `storage_unavailable`. Apps should branch on `sdk.storage.available()`
  and present a "storage unavailable in this environment" state (this is exactly the Cursor-embedded-browser case).
- Writing through a read-only namespace (`put`/`delete`/`revert`) → `storage_read_only`.
- Cross-app access without a grant → `storage_not_granted` (distinct from `not_found`, so consumers can tell
  "you may not" from "it isn't there").
- Reverting a version that doesn't exist → `not_found`; filtering/ordering by the blob field, a missing key, or a
  bad blob type → `invalid_input`.
- `revert`/optimistic-write race → `conflict` (reserved; Phase 1 is single-writer so it isn't emitted yet).

---

## 10. design-app migration (proof app)

design-app's bespoke IndexedDB store (`src/lib/store.ts`) maps directly onto `sdk.storage`, and the schema gets
*simpler* — the separate `fileVersions` store collapses into `versioned: true`:

```ts
const db = sdk.storage.namespace();

const projects  = db.collection<ProjectRow>("projects",  { key: "id", indexes: ["updatedAt"] });
const messages  = db.collection<MessageRow>("messages",  { key: "id", indexes: ["projectId", "createdAt"] });
const artifacts = db.collection<ArtifactRow>("artifacts",{ key: "projectId", blob: "html", versioned: true });
```

Call-site mapping:

| Today (`DesignStore`) | With `sdk.storage` |
|---|---|
| `listProjects()` | `projects.query({ orderBy: "updatedAt", order: "desc" })` |
| `getProject(id)` | `projects.get(id)` |
| `createProject` / `patchProject` | `projects.put(row)` |
| `deleteProject` (manual cascade) | `projects.delete(id)` + cascade helper (see note) |
| `listMessages(projectId)` | `messages.query({ where: { projectId }, orderBy: "createdAt", order: "asc" })` |
| `saveMessage` | `messages.put(msg)` |
| `getArtifact` / `writeArtifact` | `artifacts.get(pid)` / `artifacts.put(row)` (auto-versioned) |
| `listVersions` / `revertArtifact` | `artifacts.versions(pid)` / `artifacts.revert(pid, n)` |

Notes:
- `writeArtifact` no longer hand-manages version rows or the project's `updatedAt` bump — `versioned: true` covers
  history; the app does one `projects.put` to touch `updatedAt` (or a future `touch()` helper).
- **Cascade delete** across collections isn't a single primitive in v1; design-app keeps a small helper that
  deletes the project + its messages + artifact. (A declared parent/child cascade is a §13 candidate.)
- The component layer (`WorkspaceView`, `ProjectsStrip`, `HomeView`) is unchanged — only the store backing swaps.
- Result: in the UnifiedApp Tauri host, design-app data lives in the optimized SQLite+files system; in web/dev it
  transparently uses the IndexedDB backend. Same code.

---

## 11. Phasing

1. **uni-sdk surface + IndexedDB backend.** ✅ **Implemented.** `sdk.storage`, `Collection<T>`, the
   `StorageBackend` interface, `IndexedDbBackend` + `MemoryBackend`, versioning, namespacing + read-only guard, and
   the design-app migration off its bespoke IndexedDB store. Ships in uni-sdk; `sdk.storage` works everywhere
   immediately (browser IndexedDB), validated by design-app, **no Rust**.
2. **TauriBackend in UnifiedApp2.** ✅ **Implemented.** `src-tauri/src/storage.rs` — bundled SQLite (`rusqlite`)
   index + content-addressed file blobs (sha-256, ref-counted GC), namespace-partitioned, with the full command
   surface; `src/lib/tauriStorage.ts` implements `StorageBackend` over Tauri `invoke` (base64 blob transport) and
   is injected into the host SDK in `src/lib/sdk.ts` when `isTauri()`. Desktop gets the optimized local system; web
   keeps IndexedDB. **App code unchanged.** Note: remotes currently load in-realm sharing one SDK, so per-app
   namespacing is **cooperative** (apps declare their partition by manifest id, e.g. design-app → `"design"`); hard
   cross-app *enforcement* (grants at the Rust/IPC boundary) awaits the sandboxed-iframe broker.
3. **Cloud sync (deferred).** `CloudBackend` over unified-api files + a local-first sync/merge strategy, so data
   follows the user across devices. Pulls in `unified-api` / `unified-db`. Only if/when that's a goal.

---

## 12. Open questions / deferred decisions

- **Reactivity / change events.** A `collection.watch(q, cb)` would let UIs update without manual re-fetch (today
  design-app re-queries after writes). Valuable; not in v1. Worth designing the surface so it can be added without
  a break.
- **Composite/range/`in` predicates and text search** in `query()`.
- **Declared cross-collection cascade** (parent → children delete).
- **Quota & eviction** policy and `quota_exceeded` semantics per app.
- **Encryption at rest** for sensitive app data.
- **Export / import / backup** of an app's namespace as a portable bundle.
- **Cross-app *write* grants** (co-editing) — deliberately excluded for now.
- **Schema migration** when a collection's shape changes between app versions.

---

## 13. Summary

`sdk.storage` adds one uniform, typed, local-first storage resource to the SDK every UnifiedApp app already holds.
Apps declare typed collections (`collection<T>(name, schema)`); the SDK derives SQLite indexes and a file/blob split
from the schema; a swappable `StorageBackend` makes the identical code run on an optimized Tauri SQLite+files
backend (desktop) or an IndexedDB fallback (web/dev). Data is isolated per app by default, with explicit
user-granted cross-app reads enforced in the trusted host. Cloud sync is left as a clean future seam. First proof:
migrating design-app, which gets simpler in the process.

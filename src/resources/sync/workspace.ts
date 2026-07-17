// `WorkspaceSync` — the per-workspace sync engine. It keeps an in-memory
// materialized view (nested `ns → collection → id` maps) fresh against
// unified-api's `/api/v1/sync/*`: hydrate from a local snapshot (if a backend is
// injected) → catch up (bootstrap or delta) → poll deltas. Writes are
// OPTIMISTIC (applied locally, then POSTed, rolled back on failure). Offline is
// read-only by platform decision — a failed apply is never queued for retry.
//
// Every request goes through the client's own dispatcher (`client.request`), so
// auth headers, the typed error hierarchy, and the 401→refresh retry come for
// free — the engine never re-implements transport. Transport-level retry is
// disabled per request (`retry: false`) because the engine owns its own poll
// backoff.
import type { Core } from "../../core/core";
import { cpkOf, matchesWhere, pkOf } from "../storage/backend-util";
import { isEpochMismatch, syncError } from "./errors";
import { mergePatch } from "./merge";
import { Observable } from "./observable";
import { type SyncSnapshot, decodeSnapshot, encodeSnapshot } from "./snapshot";
import type {
  SnapshotBackend,
  SyncApplyResult,
  SyncCollection,
  SyncListFilter,
  SyncOp,
  SyncRecord,
  SyncState,
  SyncStatus,
  SyncStatusObservable,
  WorkspaceSyncOptions,
} from "./types";

// ─── Tuning ────────────────────────────────────────────────────────────────
const PAGE_LIMIT = 500;
const SNAPSHOT_DEBOUNCE_MS = 2000;
const BACKOFF_CAP_MS = 60_000;
const DEFAULT_POLL_MS = 5000;
const MIN_POLL_MS = 1000;
const OFFLINE_AFTER_FAILURES = 2;

// ─── Injectable timing (real timers by default; tests pass a capturing one) ──
export interface SyncTiming {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const defaultTiming: SyncTiming = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          resolve();
        },
        { once: true },
      );
    }),
};

// ─── Wire shapes (internal) ──────────────────────────────────────────────────
interface WireRecord {
  ns: string;
  collection: string;
  id: string;
  metadata: Record<string, unknown>;
  version: number;
  deleted: boolean;
  syncId: number;
  createdAt: number;
  updatedAt: number;
  hasBlob: boolean;
  blobEncoding?: string;
}
interface BootstrapResponse {
  records: WireRecord[];
  cursor: string;
  complete: boolean;
}
interface DeltaResponse {
  records: WireRecord[];
  cursor: string;
  hasMore: boolean;
}
interface ApplyResponse {
  results: SyncApplyResult[];
}

// ─── Byte → base64 (browser-safe; no node Buffer) ────────────────────────────
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function fromWire(rec: WireRecord): SyncRecord {
  return {
    ns: rec.ns,
    collection: rec.collection,
    id: rec.id,
    metadata: { ...(rec.metadata ?? {}) },
    version: rec.version,
    deleted: false,
    syncId: rec.syncId,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
    hasBlob: rec.hasBlob,
    ...(rec.blobEncoding !== undefined ? { blobEncoding: rec.blobEncoding } : {}),
  };
}

function cloneRecord(rec: SyncRecord): SyncRecord {
  return { ...rec, metadata: { ...rec.metadata } };
}

function toWireOp(op: SyncOp): Record<string, unknown> {
  const w: Record<string, unknown> = { ns: op.ns, collection: op.collection, id: op.id };
  if (op.patch !== undefined) w.patch = op.patch;
  // The server wire models `replace` as a BOOLEAN flag with the replacement
  // metadata riding in `patch` (app_objects_apply casts `op->>'replace'` to
  // boolean and, when true, sets metadata = strip(patch)). The SDK's ergonomic
  // `SyncOp.replace` is the object itself, so translate here — emitting the
  // object verbatim makes the RPC throw `invalid input syntax for type boolean`.
  if (op.replace !== undefined) {
    w.replace = true;
    w.patch = op.replace;
  }
  if (op.delete !== undefined) w.delete = op.delete;
  if (op.blobHash !== undefined) w.blob_hash = op.blobHash;
  if (op.blobEncoding !== undefined) w.blob_encoding = op.blobEncoding;
  if (op.bytes !== undefined) w.bytes = bytesToB64(op.bytes);
  return w;
}

/**
 * A live-first sync engine for one workspace. Obtain via
 * `sdk.sync.workspace(workspaceId, opts)` (which caches one instance per id).
 */
export class WorkspaceSync {
  /** Observable engine status. Mirrors the `session`-style get/subscribe shape. */
  readonly status: SyncStatusObservable;

  private readonly pollIntervalMs: number;
  // Local materialized view: cpk("ns","collection") → id → record. Only LIVE
  // records are stored (a tombstone removes the entry).
  private readonly store = new Map<string, Map<string, SyncRecord>>();
  // pk("ns","collection","id") → highest syncId ever applied locally. Persists
  // across deletes so a delete-echo arriving later via delta is deduped.
  private readonly seenSyncId = new Map<string, number>();
  // cpk → collection-change listeners.
  private readonly collectionListeners = new Map<string, Set<() => void>>();
  private readonly statusObs: Observable<SyncStatus>;

  private cursor: string | null = null;
  private bootstrapped = false;
  private running = false;
  private failures = 0;
  private startPromise: Promise<void> | null = null;
  private syncInflight: Promise<void> | null = null;
  private loopPromise: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private abort = new AbortController();

  constructor(
    private readonly client: Core,
    private readonly workspaceId: string,
    private readonly backend: SnapshotBackend | null = null,
    opts: WorkspaceSyncOptions = {},
    private readonly timing: SyncTiming = defaultTiming,
  ) {
    this.pollIntervalMs = Math.max(MIN_POLL_MS, opts.pollIntervalMs ?? DEFAULT_POLL_MS);
    this.statusObs = new Observable<SyncStatus>({ state: "idle" });
    this.status = this.statusObs;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Start the engine. Resolves once local hydration (from a snapshot, if a
   * backend is present) has been applied and rows are synchronously readable via
   * `collection().list()/get()`. Catch-up (delta or bootstrap) and polling
   * continue in the BACKGROUND after this resolves ("hydrate-then-delta").
   */
  start(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.doStart();
    return this.startPromise;
  }

  /**
   * Stop polling and (if a backend is present) flush a final snapshot
   * synchronously. Safe to call more than once.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.backend) {
      try {
        await this.flushSnapshot();
      } catch {
        // A final-save failure must not throw out of stop().
      }
    }
  }

  /**
   * Force a catch-up now (bootstrap if not yet done, then drain deltas to head).
   * Single-flighted with the background poller. Throws the SDK's typed error on
   * failure (an epoch mismatch is handled internally: state is discarded and a
   * re-bootstrap runs).
   */
  sync(): Promise<void> {
    if (!this.syncInflight) {
      this.syncInflight = this.runCatchUp().finally(() => {
        this.syncInflight = null;
      });
    }
    return this.syncInflight;
  }

  /** A read handle to one `(ns, collection)` within the local view. */
  collection(ns: string, collection: string): SyncCollection {
    const cpk = cpkOf(ns, collection);
    return {
      get: (id: string): SyncRecord | null => {
        const rec = this.getRecord(ns, collection, id);
        return rec ? cloneRecord(rec) : null;
      },
      list: (filter?: SyncListFilter): SyncRecord[] => {
        const rows = this.listCollection(ns, collection).map(cloneRecord);
        const where = filter?.where;
        return where ? rows.filter((r) => matchesWhere(r.metadata, where)) : rows;
      },
      subscribe: (listener: () => void): (() => void) => {
        let set = this.collectionListeners.get(cpk);
        if (!set) {
          set = new Set();
          this.collectionListeners.set(cpk, set);
        }
        set.add(listener);
        return () => {
          set?.delete(listener);
        };
      },
    };
  }

  /**
   * Optimistically apply a batch of 1..200 ops: mirror the expected result into
   * the local view (and notify subscribers) BEFORE the network round-trip, POST
   * to `/apply`, then stamp the server `syncId`/`version`. On any failure —
   * including offline — every touched record is rolled back to its captured
   * pre-image and the typed error is rethrown (no retry queue).
   */
  async apply(ops: SyncOp[]): Promise<SyncApplyResult[]> {
    if (ops.length < 1 || ops.length > 200) {
      throw syncError("invalid_input", "apply() expects between 1 and 200 ops");
    }
    // Capture pre-images (one per touched id) for exact rollback.
    const pre: Array<{
      ns: string;
      collection: string;
      id: string;
      record: SyncRecord | null;
      seen: number | undefined;
    }> = [];
    const seenPk = new Set<string>();
    const touched = new Set<string>();
    for (const op of ops) {
      const pk = pkOf(op.ns, op.collection, op.id);
      if (!seenPk.has(pk)) {
        seenPk.add(pk);
        const cur = this.getRecord(op.ns, op.collection, op.id);
        pre.push({
          ns: op.ns,
          collection: op.collection,
          id: op.id,
          record: cur ? cloneRecord(cur) : null,
          seen: this.seenSyncId.get(pk),
        });
      }
      this.applyOpLocally(op);
      touched.add(cpkOf(op.ns, op.collection));
    }
    this.notifyCollections(touched);
    try {
      const res = await this.client.request<ApplyResponse>(this.path("/apply"), {
        method: "POST",
        body: { ops: ops.map(toWireOp) },
        retry: false,
      });
      for (const r of res.results) {
        const rec = this.getRecord(r.ns, r.collection, r.id);
        if (rec) {
          rec.syncId = r.syncId;
          rec.version = r.version;
        }
        // Dedupe the apply-echo that will arrive later via a delta poll.
        this.seenSyncId.set(pkOf(r.ns, r.collection, r.id), r.syncId);
      }
      this.scheduleSnapshotSave();
      return res.results;
    } catch (err) {
      for (const e of pre) {
        if (e.record) this.setRecord(e.record);
        else this.removeRecord(e.ns, e.collection, e.id);
        const pk = pkOf(e.ns, e.collection, e.id);
        if (e.seen === undefined) this.seenSyncId.delete(pk);
        else this.seenSyncId.set(pk, e.seen);
      }
      this.notifyCollections(touched);
      throw err;
    }
  }

  // ─── Startup + polling ───────────────────────────────────────────────────────

  private async doStart(): Promise<void> {
    this.running = true;
    if (this.backend) {
      this.setStatus({ state: "hydrating" });
      try {
        const bytes = await this.backend.load(this.workspaceId);
        if (bytes) {
          const snap = decodeSnapshot(bytes, this.workspaceId);
          if (snap) this.applySnapshot(snap);
        }
      } catch {
        // A corrupt/failed snapshot load is treated as "no snapshot" — never
        // throw out of start() over local persistence.
      }
    }
    // Hydration is done and rows are synchronously readable. Kick off the
    // background catch-up + poll loop WITHOUT awaiting it.
    this.loopPromise = this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    let backoff = this.pollIntervalMs;
    while (this.running) {
      // Capture BEFORE the sync: a successful catch-up runs bootstrap(), which
      // moves the state to `bootstrapping`, so reading the state afterwards
      // would miss that we were recovering from `offline`.
      const wasOffline = this.statusObs.get().state === "offline";
      let ok = false;
      try {
        await this.sync();
        ok = true;
      } catch (err) {
        this.recordFailure(err);
      }
      if (!this.running) break;
      if (ok) {
        const recovered = wasOffline;
        this.failures = 0;
        this.setStatus({ state: "live", lastSyncAt: this.timing.now() });
        backoff = this.pollIntervalMs;
        // On recovery, poll again immediately instead of waiting out the interval.
        await this.timing.sleep(recovered ? 0 : this.pollIntervalMs, this.abort.signal);
      } else {
        const delay = backoff;
        backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
        await this.timing.sleep(delay, this.abort.signal);
      }
    }
  }

  private recordFailure(err: unknown): void {
    this.failures += 1;
    if (this.failures >= OFFLINE_AFTER_FAILURES) {
      this.setStatus({ state: "offline", error: err });
    }
  }

  // ─── Catch-up (bootstrap / delta / epoch reset) ──────────────────────────────

  private async runCatchUp(): Promise<void> {
    const touched = new Set<string>();
    try {
      if (!this.bootstrapped) await this.bootstrap(touched);
      await this.deltaDrain(touched);
    } catch (err) {
      if (!isEpochMismatch(err)) throw err;
      // Epoch reset: discard ALL local state, wipe the snapshot, re-bootstrap,
      // and notify every active subscriber once the fresh state is in.
      this.clearStore();
      if (this.backend) {
        try {
          await this.backend.clear(this.workspaceId);
        } catch {
          // Best-effort clear — an unremovable snapshot is superseded by the
          // save that follows the re-bootstrap.
        }
      }
      this.cursor = null;
      this.bootstrapped = false;
      const reset = new Set<string>();
      await this.bootstrap(reset);
      await this.deltaDrain(reset);
      this.notifyAllSubscribers();
      this.scheduleSnapshotSave();
      return;
    }
    this.notifyCollections(touched);
    this.scheduleSnapshotSave();
  }

  private async bootstrap(touched: Set<string>): Promise<void> {
    this.setStatus({ state: "bootstrapping" });
    // Reconcile-on-complete: rows already present locally when a FULL bootstrap
    // begins (hydrated from a snapshot that had no resumable delta cursor) are
    // "stale candidates". Bootstrap returns only LIVE rows and never tombstones,
    // so any pre-existing row the complete snapshot never re-lists was deleted
    // server-side while we were away — drop it once the whole snapshot is seen.
    // Rows created locally DURING the bootstrap (e.g. an optimistic apply, whose
    // syncId is above the snapshot ceiling) are NOT candidates and are kept.
    const staleCandidates = new Set(
      this.allLiveRecords().map((r) => pkOf(r.ns, r.collection, r.id)),
    );
    const seenKeys = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      const res = await this.client.request<BootstrapResponse>(this.path("/bootstrap"), {
        method: "GET",
        query: { ...(cursor !== undefined ? { cursor } : {}), limit: PAGE_LIMIT },
        retry: false,
      });
      // Track every key the snapshot lists, independent of dedupe (a hydrated
      // row re-listed at its known syncId is a no-op in ingest but must still
      // count as "seen" so reconcile does not drop it).
      for (const rec of res.records) seenKeys.add(pkOf(rec.ns, rec.collection, rec.id));
      this.ingest(res.records, touched);
      cursor = res.cursor;
      if (res.complete) {
        // On completion the cursor becomes the delta cursor.
        this.cursor = res.cursor;
        this.bootstrapped = true;
        this.reconcileStale(staleCandidates, seenKeys, touched);
        break;
      }
    }
  }

  /**
   * Drop pre-existing local rows a completed full bootstrap did not re-list —
   * they were deleted server-side during an offline window (bootstrap carries no
   * tombstone to signal it). Touched collections are recorded for notification.
   */
  private reconcileStale(candidates: Set<string>, seen: Set<string>, touched: Set<string>): void {
    if (candidates.size === 0) return;
    for (const rec of this.allLiveRecords()) {
      const key = pkOf(rec.ns, rec.collection, rec.id);
      if (candidates.has(key) && !seen.has(key)) {
        if (this.removeRecord(rec.ns, rec.collection, rec.id))
          touched.add(cpkOf(rec.ns, rec.collection));
        this.seenSyncId.delete(key);
      }
    }
  }

  private async deltaDrain(touched: Set<string>): Promise<void> {
    for (;;) {
      const res = await this.client.request<DeltaResponse>(this.path("/delta"), {
        method: "GET",
        query: { ...(this.cursor !== null ? { cursor: this.cursor } : {}), limit: PAGE_LIMIT },
        retry: false,
      });
      this.ingest(res.records, touched);
      this.cursor = res.cursor;
      if (!res.hasMore) break;
    }
  }

  // ─── Ingest + dedupe ─────────────────────────────────────────────────────────

  private ingest(records: WireRecord[], touched: Set<string>): void {
    for (const rec of records) {
      const pk = pkOf(rec.ns, rec.collection, rec.id);
      const seen = this.seenSyncId.get(pk);
      // Dedupe: anything we already applied at or beyond this syncId (an
      // apply-echo, or a re-sent row) is a no-op — no store change, no notify.
      if (seen !== undefined && seen >= rec.syncId) continue;
      this.seenSyncId.set(pk, rec.syncId);
      const cpk = cpkOf(rec.ns, rec.collection);
      if (rec.deleted) {
        // A tombstone REMOVES the local record entirely. Only notify if it was
        // actually present (a delete of an unknown id is a silent no-op).
        if (this.removeRecord(rec.ns, rec.collection, rec.id)) touched.add(cpk);
      } else {
        this.setRecord(fromWire(rec));
        touched.add(cpk);
      }
    }
  }

  // ─── Optimistic local mutation (mirrors the server merge in JS) ──────────────

  private applyOpLocally(op: SyncOp): void {
    if (op.delete) {
      this.removeRecord(op.ns, op.collection, op.id);
      return;
    }
    const existing = this.getRecord(op.ns, op.collection, op.id);
    const now = this.timing.now();
    let metadata: Record<string, unknown>;
    if (op.replace !== undefined) metadata = { ...op.replace };
    else if (op.patch !== undefined) metadata = mergePatch(existing?.metadata ?? {}, op.patch);
    else metadata = existing ? { ...existing.metadata } : {};
    const hasBlob =
      op.blobHash !== undefined || op.bytes !== undefined ? true : (existing?.hasBlob ?? false);
    const blobEncoding = op.blobEncoding ?? existing?.blobEncoding;
    const rec: SyncRecord = {
      ns: op.ns,
      collection: op.collection,
      id: op.id,
      metadata,
      version: existing?.version ?? 0,
      deleted: false,
      syncId: existing?.syncId ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      hasBlob,
      ...(blobEncoding !== undefined ? { blobEncoding } : {}),
    };
    this.setRecord(rec);
  }

  // ─── Snapshot (debounced save; hydration) ────────────────────────────────────

  private applySnapshot(snap: SyncSnapshot): void {
    this.clearStore();
    for (const rec of snap.records) {
      // Snapshots only carry live records; normalize + seed the dedupe map.
      this.setRecord({ ...rec, deleted: false, metadata: { ...rec.metadata } });
      this.seenSyncId.set(pkOf(rec.ns, rec.collection, rec.id), rec.syncId);
    }
    this.cursor = snap.cursor ?? null;
    // With a saved cursor we resume via delta (skip bootstrap); without one we
    // still need a full bootstrap.
    this.bootstrapped = this.cursor !== null;
  }

  private scheduleSnapshotSave(): void {
    if (!this.backend) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.flushSnapshot();
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  private async flushSnapshot(): Promise<void> {
    if (!this.backend) return;
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const bytes = encodeSnapshot(
      this.workspaceId,
      this.cursor,
      this.allLiveRecords(),
      this.timing.now(),
    );
    await this.backend.save(this.workspaceId, bytes);
  }

  // ─── Status ──────────────────────────────────────────────────────────────────

  private setStatus(next: { state: SyncState; lastSyncAt?: number; error?: unknown }): void {
    const cur = this.statusObs.get();
    const lastSyncAt = next.lastSyncAt ?? cur.lastSyncAt;
    const status: SyncStatus = {
      state: next.state,
      ...(lastSyncAt !== undefined ? { lastSyncAt } : {}),
      // Clear the error once we're back to `live`.
      ...(next.error !== undefined && next.state !== "live" ? { error: next.error } : {}),
    };
    this.statusObs.set(status);
  }

  // ─── In-memory store helpers ────────────────────────────────────────────────

  private getRecord(ns: string, collection: string, id: string): SyncRecord | undefined {
    return this.store.get(cpkOf(ns, collection))?.get(id);
  }

  private setRecord(rec: SyncRecord): void {
    const cpk = cpkOf(rec.ns, rec.collection);
    let m = this.store.get(cpk);
    if (!m) {
      m = new Map();
      this.store.set(cpk, m);
    }
    m.set(rec.id, rec);
  }

  private removeRecord(ns: string, collection: string, id: string): boolean {
    return this.store.get(cpkOf(ns, collection))?.delete(id) ?? false;
  }

  private listCollection(ns: string, collection: string): SyncRecord[] {
    const m = this.store.get(cpkOf(ns, collection));
    return m ? [...m.values()] : [];
  }

  private allLiveRecords(): SyncRecord[] {
    const out: SyncRecord[] = [];
    for (const m of this.store.values()) for (const rec of m.values()) out.push(rec);
    return out;
  }

  private clearStore(): void {
    this.store.clear();
    this.seenSyncId.clear();
  }

  // ─── Subscriber notification ─────────────────────────────────────────────────

  private notifyCollections(touched: Set<string>): void {
    for (const cpk of touched) this.fireCollection(cpk);
  }

  private notifyAllSubscribers(): void {
    for (const cpk of this.collectionListeners.keys()) this.fireCollection(cpk);
  }

  private fireCollection(cpk: string): void {
    const set = this.collectionListeners.get(cpk);
    if (!set) return;
    for (const listener of set) {
      try {
        listener();
      } catch {
        // A host listener must never break the engine or the other listeners.
      }
    }
  }

  private path(suffix: string): string {
    return `/api/v1/sync/${encodeURIComponent(this.workspaceId)}${suffix}`;
  }
}

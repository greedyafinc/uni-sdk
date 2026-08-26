import type { Core } from "../../core/core.js";
import type { SnapshotBackend, SyncApplyResult, SyncCollection, SyncOp, SyncStatusObservable, WorkspaceSyncOptions } from "./types.js";
export interface SyncTiming {
    now(): number;
    sleep(ms: number, signal?: AbortSignal): Promise<void>;
}
export declare const defaultTiming: SyncTiming;
/**
 * A live-first sync engine for one workspace. Obtain via
 * `sdk.sync.workspace(workspaceId, opts)` (which caches one instance per id).
 */
export declare class WorkspaceSync {
    private readonly client;
    private readonly workspaceId;
    private readonly backend;
    private readonly timing;
    /** Observable engine status. Mirrors the `session`-style get/subscribe shape. */
    readonly status: SyncStatusObservable;
    private readonly pollIntervalMs;
    private readonly store;
    private readonly seenSyncId;
    private readonly collectionListeners;
    private readonly statusObs;
    private cursor;
    private bootstrapped;
    private running;
    private failures;
    private startPromise;
    private syncInflight;
    private loopPromise;
    private saveTimer;
    private abort;
    constructor(client: Core, workspaceId: string, backend?: SnapshotBackend | null, opts?: WorkspaceSyncOptions, timing?: SyncTiming);
    /**
     * Start the engine. Resolves once local hydration (from a snapshot, if a
     * backend is present) has been applied and rows are synchronously readable via
     * `collection().list()/get()`. Catch-up (delta or bootstrap) and polling
     * continue in the BACKGROUND after this resolves ("hydrate-then-delta").
     */
    start(): Promise<void>;
    /**
     * Stop polling and (if a backend is present) flush a final snapshot
     * synchronously. Safe to call more than once.
     */
    stop(): Promise<void>;
    /**
     * Force a catch-up now (bootstrap if not yet done, then drain deltas to head).
     * Single-flighted with the background poller. Throws the SDK's typed error on
     * failure (an epoch mismatch is handled internally: state is discarded and a
     * re-bootstrap runs).
     */
    sync(): Promise<void>;
    /** A read handle to one `(ns, collection)` within the local view. */
    collection(ns: string, collection: string): SyncCollection;
    /**
     * Optimistically apply a batch of 1..200 ops: mirror the expected result into
     * the local view (and notify subscribers) BEFORE the network round-trip, POST
     * to `/apply`, then stamp the server `syncId`/`version`. On any failure —
     * including offline — every touched record is rolled back to its captured
     * pre-image and the typed error is rethrown (no retry queue).
     */
    apply(ops: SyncOp[]): Promise<SyncApplyResult[]>;
    private doStart;
    private pollLoop;
    private recordFailure;
    private runCatchUp;
    private bootstrap;
    /**
     * Drop pre-existing local rows a completed full bootstrap did not re-list —
     * they were deleted server-side during an offline window (bootstrap carries no
     * tombstone to signal it). Touched collections are recorded for notification.
     */
    private reconcileStale;
    private deltaDrain;
    private ingest;
    private applyOpLocally;
    private applySnapshot;
    private scheduleSnapshotSave;
    private flushSnapshot;
    private setStatus;
    private getRecord;
    private setRecord;
    private removeRecord;
    private listCollection;
    private allLiveRecords;
    private clearStore;
    private notifyCollections;
    private notifyAllSubscribers;
    private fireCollection;
    private path;
}
//# sourceMappingURL=workspace.d.ts.map
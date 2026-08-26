import { MemoryGrantStore } from "../_kv/sharing.js";
export interface FakeSyncServerOptions {
    /** Workspace ids that reject blob ops with 400 `blobs_not_supported_in_shared_workspaces`. */
    sharedWorkspaces?: string[];
    /** Base url the SDK is pointed at (cosmetic; routing is by path). */
    baseUrl?: string;
    /**
     * Caller's `plans.id`. `PLAN_FREE_ID` (0) makes bootstrap/delta/apply
     * return 403 `plan_required`. Omit (default) to leave the caller entitled
     * — existing tests keep working. Local UnifiedApp sets this from the
     * desktop session; it does not call production billing.
     */
    cloudPlanId?: number;
    /**
     * Share this grant table with `MemoryBackend` / `UnifiedAI({ grantStore })`
     * in the same local host process. Omit to create a private table.
     */
    grants?: MemoryGrantStore;
}
/** An in-memory `/api/v1/sync/*` server exposed as a `fetch` implementation. */
export declare class FakeSyncServer {
    readonly baseUrl: string;
    /** Inspectable grant table (same contract as MemoryBackend.grants). */
    readonly grants: MemoryGrantStore;
    private readonly shared;
    private readonly workspaces;
    private readonly meta;
    private failApply;
    private offline;
    private cloudPlanId;
    /** Number of requests served — for asserting no redundant round-trips. */
    requestCount: number;
    constructor(opts?: FakeSyncServerOptions);
    /** Override the caller's plan for the Pro gate (`0` = Free). */
    setCloudPlanId(id: number | undefined): void;
    /** Bump the epoch so the next bootstrap/delta with an older cursor → 409. */
    bumpEpoch(workspaceId: string): void;
    /**
     * Register a workspace's membership metadata so it surfaces from
     * `GET /sync/workspaces`. Also materializes the workspace state (so its
     * bootstrap/delta endpoints answer even before any write).
     */
    registerWorkspace(workspaceId: string, meta?: {
        name?: string;
        kind?: "personal" | "team";
        role?: "owner" | "member";
    }): void;
    /** Directly seed records (bypassing HTTP) for test setup. Advances `sync_id`. */
    seed(workspaceId: string, records: Array<{
        ns: string;
        collection: string;
        id: string;
        metadata: Record<string, unknown>;
    }>): void;
    /** Apply arbitrary wire-shaped ops server-side (bypassing HTTP), advancing `sync_id`. */
    applyOps(workspaceId: string, ops: Array<Record<string, unknown>>): void;
    /** Server-side delete (tombstone) of a record. */
    remove(workspaceId: string, ns: string, collection: string, id: string): void;
    /** When on, `/apply` returns 500. */
    setApplyFailing(on: boolean): void;
    /** When on, `/bootstrap` and `/delta` return 503 (simulating a network outage). */
    setOffline(on: boolean): void;
    /** The `fetch` implementation to pass as `new UnifiedAI({ fetch: server.fetch })`. */
    fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
    private listWorkspaces;
    private bootstrap;
    private delta;
    private apply;
    private applyOne;
    private ws;
    private limit;
    private maxSyncId;
    private planGate;
    /**
     * Unscoped callers (no `x-unified-app`) are treated as first-party and see
     * every namespace — matching existing tests and the desktop host. A stamped
     * app identity is grant-filtered.
     */
    private nsVisible;
    private handleGrants;
}
//# sourceMappingURL=fake-server.d.ts.map
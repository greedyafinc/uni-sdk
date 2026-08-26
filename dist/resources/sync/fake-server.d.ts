export interface FakeSyncServerOptions {
    /** Workspace ids that reject blob ops with 400 `blobs_not_supported_in_shared_workspaces`. */
    sharedWorkspaces?: string[];
    /** Base url the SDK is pointed at (cosmetic; routing is by path). */
    baseUrl?: string;
}
/** An in-memory `/api/v1/sync/*` server exposed as a `fetch` implementation. */
export declare class FakeSyncServer {
    readonly baseUrl: string;
    private readonly shared;
    private readonly workspaces;
    private readonly meta;
    private failApply;
    private offline;
    /** Number of requests served — for asserting no redundant round-trips. */
    requestCount: number;
    constructor(opts?: FakeSyncServerOptions);
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
}
//# sourceMappingURL=fake-server.d.ts.map
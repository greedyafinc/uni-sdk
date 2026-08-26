import type { Core } from "../core/core.js";
export interface MemoryEvent {
    id: string;
    projectId: string | null;
    type: string;
    content: unknown;
    /** SERVER-stamped: "host" | "app:<id>" | "mcp-external". */
    taintOrigin: string;
    provenance: Record<string, unknown>;
    salience: Record<string, unknown>;
    status: "applied" | "proposed";
    /** Monotonic append cursor. */
    seq: number;
    createdAt: number;
}
export interface MemoryEventInput {
    type: string;
    content: unknown;
    provenance?: Record<string, unknown>;
    salience?: Record<string, unknown>;
}
export interface SyncOptions {
    /** Return events with seq greater than this cursor. */
    since?: number | string;
    projectId?: string;
    signal?: AbortSignal;
}
export interface QueryOptions {
    k?: number;
    projectId?: string;
    /** RRF-fuse lexical + vector ranking (§6a). Default lexical-only. */
    hybrid?: boolean;
}
/** A search hit. `score` is null under the local/lexical path; numeric under cloud RRF. */
export interface MemoryHit {
    event: MemoryEvent;
    score: number | null;
}
export declare class Memory {
    private readonly client;
    constructor(client: Core);
    /** Append a batch of events. The server stamps id/taintOrigin/status. */
    append(events: MemoryEventInput[], projectId?: string | null): Promise<MemoryEvent[]>;
    /** Append-only sync: events since a cursor, plus the new cursor to persist. */
    sync(options?: SyncOptions): Promise<{
        events: MemoryEvent[];
        cursor: number;
    }>;
    /** Lexical search over applied memory. */
    query(query: string, options?: QueryOptions): Promise<MemoryHit[]>;
}
//# sourceMappingURL=memory.d.ts.map
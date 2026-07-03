// `sdk.memory` — the server-side agent-memory ledger (PROTOCOL.md §Memory). Append-only
// events; the server stamps `taintOrigin` + `status` from the caller's credential, so a
// standalone app's writes land as `proposed` (surfaced for confirmation in the owning
// app) while the user's own credentials `apply` directly. Retrieval is lexical in v1.
import type { Core, RequestOptions } from "../core/core";

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

export class Memory {
  constructor(private readonly client: Core) {}

  /** Append a batch of events. The server stamps id/taintOrigin/status. */
  async append(events: MemoryEventInput[], projectId?: string | null): Promise<MemoryEvent[]> {
    const body: Record<string, unknown> = { events };
    if (projectId !== undefined) body.projectId = projectId;
    const res = await this.client.request<{ events: MemoryEvent[] }>("/api/v1/memory/events", {
      method: "POST",
      body,
    });
    return res.events;
  }

  /** Append-only sync: events since a cursor, plus the new cursor to persist. */
  sync(options: SyncOptions = {}): Promise<{ events: MemoryEvent[]; cursor: number }> {
    const req: RequestOptions = { method: "GET" };
    const query: Record<string, string> = {};
    if (options.since !== undefined) query.since = String(options.since);
    if (options.projectId) query.projectId = options.projectId;
    if (Object.keys(query).length) req.query = query;
    if (options.signal) req.signal = options.signal;
    return this.client.request<{ events: MemoryEvent[]; cursor: number }>("/api/v1/memory/events", req);
  }

  /** Lexical search over applied memory. */
  async query(query: string, options: QueryOptions = {}): Promise<MemoryHit[]> {
    const body: Record<string, unknown> = { query };
    if (options.k !== undefined) body.k = options.k;
    if (options.projectId) body.projectId = options.projectId;
    if (options.hybrid) body.hybrid = true;
    const res = await this.client.request<{ results: MemoryHit[] }>("/api/v1/memory/query", {
      method: "POST",
      body,
    });
    return res.results;
  }
}

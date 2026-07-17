// `sdk.sync` — the entry point to the per-workspace sync engine. It caches ONE
// `WorkspaceSync` per workspace id (so `.workspace(id)` twice returns the same
// handle) and threads through the host-injected `SnapshotBackend` (if any). The
// engine itself works online-only when no backend is present — there is no
// browser persistence fallback. See PROTOCOL.md ("Sync").
import type { Core } from "../../core/core";
import type { SnapshotBackend, WorkspaceSummary, WorkspaceSyncOptions } from "./types";
import { WorkspaceSync } from "./workspace";

interface WorkspaceListResponse {
  workspaces: WorkspaceSummary[];
}

export class Sync {
  private readonly workspaces = new Map<string, WorkspaceSync>();

  constructor(private readonly client: Core) {}

  /**
   * List the workspaces the authenticated caller belongs to (id, name, kind,
   * role) via unified-api's `GET /sync/workspaces`. An app uses this to discover
   * its personal workspace id without a round-trip to base-api.
   */
  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    const res = await this.client.request<WorkspaceListResponse>("/api/v1/sync/workspaces", {
      method: "GET",
      retry: false,
    });
    return res.workspaces;
  }

  /**
   * Open (or reuse) the sync engine for `workspaceId`. `opts` is honored only on
   * the first call for a given id — later calls return the cached handle.
   */
  workspace(workspaceId: string, opts: WorkspaceSyncOptions = {}): WorkspaceSync {
    let ws = this.workspaces.get(workspaceId);
    if (!ws) {
      ws = new WorkspaceSync(this.client, workspaceId, this.resolveBackend(), opts);
      this.workspaces.set(workspaceId, ws);
    }
    return ws;
  }

  private resolveBackend(): SnapshotBackend | null {
    return this.client.snapshotBackend ?? null;
  }
}

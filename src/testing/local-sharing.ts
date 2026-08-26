// Local UnifiedApp / desktop sharing runtime. Import from
// `@unifiedai/sdk/testing` — FakeSyncServer must not ship in production
// bundles. The host wires the same pieces (shared MemoryGrantStore +
// MemoryBackend + FakeSyncServer as `fetch`) so planner/docs/Grok Bot can
// share a namespace without talking to production unified-api.
import { UnifiedAI } from "../core/client";
import { MemoryGrantStore } from "../resources/_kv/sharing";
import { MemoryBackend } from "../resources/storage/memory";
import { FakeSyncServer } from "../resources/sync/fake-server";

export interface LocalSharingRuntime {
  grantStore: MemoryGrantStore;
  storage: MemoryBackend;
  server: FakeSyncServer;
  /**
   * Per-app SDK sharing the in-process backends. `appId` is host-stamped;
   * pass `callerKind: "agent"` for Grok Bot / MCP-style callers.
   */
  client(opts: { appId: string; callerKind?: "app" | "agent" }): UnifiedAI;
}

export interface LocalSharingRuntimeOptions {
  /**
   * Caller's `plans.id` for the local Pro gate. `0` (Free) makes
   * bootstrap/delta/apply return `plan_required`. Omit to leave the caller
   * entitled (typical desktop local-dev).
   */
  cloudPlanId?: number;
}

/**
 * In-process sharing host: one grant table, one storage backend, one fake
 * sync server. UnifiedApp desktop local-dev (and this repo's tests) construct
 * per-app SDKs with {@link LocalSharingRuntime.client}. Cloud Pro-gating is
 * modeled on the fake server; nothing here talks to production.
 */
export function createLocalSharingRuntime(
  opts: LocalSharingRuntimeOptions = {},
): LocalSharingRuntime {
  const grantStore = new MemoryGrantStore();
  const storage = new MemoryBackend({ grants: grantStore });
  const server = new FakeSyncServer({
    grants: grantStore,
    ...(opts.cloudPlanId !== undefined ? { cloudPlanId: opts.cloudPlanId } : {}),
  });
  return {
    grantStore,
    storage,
    server,
    client({ appId, callerKind }) {
      return new UnifiedAI({
        appId,
        token: "local",
        storage,
        grantStore,
        apiUrl: server.baseUrl,
        fetch: server.fetch as unknown as typeof fetch,
        ...(callerKind ? { callerKind } : {}),
      });
    },
  };
}

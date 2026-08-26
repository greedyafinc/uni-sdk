import { UnifiedAI } from "../core/client.js";
import { MemoryGrantStore } from "../resources/_kv/sharing.js";
import { MemoryBackend } from "../resources/storage/memory.js";
import { FakeSyncServer } from "../resources/sync/fake-server.js";
export interface LocalSharingRuntime {
    grantStore: MemoryGrantStore;
    storage: MemoryBackend;
    server: FakeSyncServer;
    /**
     * Per-app SDK sharing the in-process backends. `appId` is host-stamped;
     * pass `callerKind: "agent"` for Grok Bot / MCP-style callers.
     */
    client(opts: {
        appId: string;
        callerKind?: "app" | "agent";
    }): UnifiedAI;
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
export declare function createLocalSharingRuntime(opts?: LocalSharingRuntimeOptions): LocalSharingRuntime;
//# sourceMappingURL=local-sharing.d.ts.map
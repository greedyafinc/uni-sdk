import { subsystemError } from "../../core/errors.js";
import type { KvNamespaceMode } from "./namespace.js";
/** Access mode a grant conveys. `"readwrite"` implies `"read"`. */
export type NamespaceGrantMode = KvNamespaceMode;
/**
 * Who a grant is for.
 *
 * - `{ type: "app", appId }` — another marketplace app, identified by the
 *   same `appId` the host stamps on its SDK (and sends as `x-unified-app`).
 * - `{ type: "agent" }` — an authenticated agent credential (Grok Bot,
 *   `mcp-external`, or a client constructed with `callerKind: "agent"`).
 *   Agent grants are not app-scoped: any authenticated agent matching the
 *   server's caller class may use them.
 */
export type NamespaceGrantee = {
    type: "app";
    appId: string;
} | {
    type: "agent";
};
/** One stored grant. `id` is server-assigned (or locally generated). */
export interface NamespaceGrant {
    id: string;
    /** Owning app namespace. Defaults to the granting caller's `appId`. */
    ns: string;
    grantee: NamespaceGrantee;
    mode: NamespaceGrantMode;
    createdAt: number;
    updatedAt: number;
}
export interface NamespaceGrantInput {
    /**
     * Namespace to share. Omit to share the calling app's own namespace
     * (`client.appId`). A caller may only grant its own namespace.
     */
    ns?: string;
    grantee: NamespaceGrantee;
    /** Defaults to `"read"`. Cross-app write grants are allowed but uncommon. */
    mode?: NamespaceGrantMode;
}
export interface ListNamespaceGrantsOptions {
    /** Restrict to one namespace. Defaults to the calling app's own. */
    ns?: string;
}
/** Caller identity used when checking a grant (host-stamped, never self-declared). */
export interface SharingCaller {
    appId: string;
    kind: "app" | "agent";
}
/**
 * In-memory grant table. MemoryBackend owns one; tests may share a backend
 * (and therefore its grants) across two SDK clients.
 */
export declare class MemoryGrantStore {
    private readonly byId;
    /** `${ns}\0${granteeKey}` → grant id, for upsert-by-grantee. */
    private readonly byNsGrantee;
    list(ns: string): NamespaceGrant[];
    get(id: string): NamespaceGrant | undefined;
    upsert(ns: string, grantee: NamespaceGrantee, mode: NamespaceGrantMode): NamespaceGrant;
    delete(id: string): boolean;
    /** True when `caller` may access `ns` at `mode` (own ns, or a matching grant). */
    allows(caller: SharingCaller, ns: string, mode: NamespaceGrantMode): boolean;
}
/**
 * Own-namespace is always allowed. Cross-app requires a grant whose mode
 * covers the requested mode (`readwrite` covers `read`). Agent callers match
 * `{ type: "agent" }` grants; app callers match `{ type: "app", appId }`.
 */
export declare function namespaceAccess(store: MemoryGrantStore, caller: SharingCaller, ns: string, mode: NamespaceGrantMode): boolean;
export declare function notGrantedError(subsystem: "storage" | "sync" | "fs", ns: string): ReturnType<typeof subsystemError>;
//# sourceMappingURL=sharing.d.ts.map
import type { Core } from "../../core/core.js";
import { type ListNamespaceGrantsOptions, type MemoryGrantStore, type NamespaceGrant, type NamespaceGrantInput, type NamespaceGrantMode } from "./sharing.js";
export type SharingResource = "storage" | "sync";
export interface NamespaceSharingOptions {
    resource: SharingResource;
    client: Core;
    /** When set, grant CRUD is local (no HTTP). Cloud otherwise. */
    local: MemoryGrantStore | null;
    /**
     * Resolve the caller's own namespace. Storage/fs use `client.appId`;
     * sync uses the same — grants are namespace-scoped, not workspace-scoped.
     */
    ownNs: () => string;
}
/**
 * Grant surface shared by storage and sync. An owning app publishes access
 * to its namespace; consumers then open `namespace("other-app")` (storage)
 * or read `(ns, collection)` from a `WorkspaceSync` (sync).
 */
export declare class NamespaceSharing {
    private readonly opts;
    constructor(opts: NamespaceSharingOptions);
    private caller;
    private own;
    private resolveNs;
    /** List grants this app has published on `ns` (defaults to own namespace). */
    list(opts?: ListNamespaceGrantsOptions): Promise<NamespaceGrant[]>;
    /**
     * Grant (or upsert) access to a namespace. Only the owning app may grant
     * its own namespace. Re-granting the same grantee updates `mode`.
     */
    grant(input: NamespaceGrantInput): Promise<NamespaceGrant>;
    /** Revoke a grant by id. Returns `true` if it existed. */
    revoke(id: string): Promise<boolean>;
    /**
     * Local-only access check used by injected backends. Cloud backends skip
     * this and let unified-api enforce (the SDK maps `*_not_granted`).
     */
    assertLocalAccess(targetNs: string, mode: NamespaceGrantMode): void;
    private assertOwner;
    private collectionPath;
    private itemPath;
}
//# sourceMappingURL=grants.d.ts.map
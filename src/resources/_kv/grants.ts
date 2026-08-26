// Namespace grant CRUD used by `sdk.storage.grants` and `sdk.sync.grants`.
// Cloud: unified-api `/api/v1/{storage|sync}/grants`. Local: MemoryGrantStore
// (injected MemoryBackend, or a store FakeSyncServer keeps internally).
import type { Core } from "../../core/core";
import { UnifiedError } from "../../core/errors";
import {
  type ListNamespaceGrantsOptions,
  type MemoryGrantStore,
  type NamespaceGrant,
  type NamespaceGrantInput,
  type NamespaceGrantMode,
  type SharingCaller,
  namespaceAccess,
  notGrantedError,
} from "./sharing";

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
export class NamespaceSharing {
  constructor(private readonly opts: NamespaceSharingOptions) {}

  private caller(): SharingCaller {
    return { appId: this.opts.ownNs(), kind: this.opts.client.callerKind };
  }

  private own(): string {
    const ns = this.opts.ownNs().trim();
    if (!ns) {
      throw new UnifiedError(
        "invalid_input",
        `cannot manage ${this.opts.resource} grants without an appId`,
      );
    }
    return ns;
  }

  private resolveNs(ns: string | undefined): string {
    const trimmed = ns?.trim();
    return trimmed || this.own();
  }

  /** List grants this app has published on `ns` (defaults to own namespace). */
  async list(opts: ListNamespaceGrantsOptions = {}): Promise<NamespaceGrant[]> {
    const ns = this.resolveNs(opts.ns);
    this.assertOwner(ns);
    if (this.opts.local) return this.opts.local.list(ns);
    const res = await this.opts.client.request<{ grants: NamespaceGrant[] }>(
      this.collectionPath(),
      {
        method: "GET",
        query: { ns },
      },
    );
    return res.grants;
  }

  /**
   * Grant (or upsert) access to a namespace. Only the owning app may grant
   * its own namespace. Re-granting the same grantee updates `mode`.
   */
  async grant(input: NamespaceGrantInput): Promise<NamespaceGrant> {
    const ns = this.resolveNs(input.ns);
    this.assertOwner(ns);
    const mode: NamespaceGrantMode = input.mode ?? "read";
    if (this.opts.local) return this.opts.local.upsert(ns, input.grantee, mode);
    return this.opts.client.request<NamespaceGrant>(this.collectionPath(), {
      method: "POST",
      body: { ns, grantee: input.grantee, mode },
    });
  }

  /** Revoke a grant by id. Returns `true` if it existed. */
  async revoke(id: string): Promise<boolean> {
    if (!id.trim()) throw new UnifiedError("invalid_input", "grant id is required");
    if (this.opts.local) {
      const g = this.opts.local.get(id);
      if (g) this.assertOwner(g.ns);
      return this.opts.local.delete(id);
    }
    const res = await this.opts.client.request<{ revoked: boolean }>(this.itemPath(id), {
      method: "DELETE",
    });
    return res.revoked;
  }

  /**
   * Local-only access check used by injected backends. Cloud backends skip
   * this and let unified-api enforce (the SDK maps `*_not_granted`).
   */
  assertLocalAccess(targetNs: string, mode: NamespaceGrantMode): void {
    const local = this.opts.local;
    if (!local) return;
    if (namespaceAccess(local, this.caller(), targetNs, mode)) return;
    throw notGrantedError(this.opts.resource, targetNs);
  }

  private assertOwner(ns: string): void {
    if (ns !== this.own()) {
      throw new UnifiedError(
        "invalid_input",
        `only the owning app can manage grants for namespace "${ns}"`,
      );
    }
  }

  private collectionPath(): string {
    return `/api/v1/${this.opts.resource}/grants`;
  }

  private itemPath(id: string): string {
    return `${this.collectionPath()}/${encodeURIComponent(id)}`;
  }
}

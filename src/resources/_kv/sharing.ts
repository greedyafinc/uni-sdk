// Generic namespace sharing — the capability layer that lets any marketplace
// app expose its namespaced storage/sync data to (a) other apps and
// (b) authenticated agents. Domain-agnostic: no planner (or any app) types.
//
// Isolation by default: a caller always has read-write on its own namespace
// (`client.appId`). Cross-app and agent access require an explicit grant,
// enforced locally for injected backends (MemoryBackend / FakeSyncServer) and
// at unified-api for the Cloud backends. See PROTOCOL.md §Namespace sharing.
import { subsystemError } from "../../core/errors";
import type { KvNamespaceMode } from "./namespace";

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
export type NamespaceGrantee = { type: "app"; appId: string } | { type: "agent" };

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

let grantSeq = 0;

function nextGrantId(): string {
  grantSeq += 1;
  return `ngr_${grantSeq.toString(36)}`;
}

function granteeKey(g: NamespaceGrantee): string {
  return g.type === "agent" ? "agent" : `app:${g.appId}`;
}

function validateGrantee(g: NamespaceGrantee): NamespaceGrantee {
  if (g.type === "agent") return { type: "agent" };
  if (g.type === "app") {
    const appId = g.appId.trim();
    if (!appId) {
      throw subsystemError("invalid_input", "grantee.appId must be a non-empty string");
    }
    return { type: "app", appId };
  }
  throw subsystemError("invalid_input", 'grantee.type must be "app" or "agent"');
}

/**
 * In-memory grant table. MemoryBackend owns one; tests may share a backend
 * (and therefore its grants) across two SDK clients.
 */
export class MemoryGrantStore {
  private readonly byId = new Map<string, NamespaceGrant>();
  /** `${ns}\0${granteeKey}` → grant id, for upsert-by-grantee. */
  private readonly byNsGrantee = new Map<string, string>();

  list(ns: string): NamespaceGrant[] {
    const out: NamespaceGrant[] = [];
    for (const g of this.byId.values()) {
      if (g.ns === ns) out.push({ ...g, grantee: { ...g.grantee } });
    }
    out.sort((a, b) => a.createdAt - b.createdAt);
    return out;
  }

  get(id: string): NamespaceGrant | undefined {
    const g = this.byId.get(id);
    return g ? { ...g, grantee: { ...g.grantee } } : undefined;
  }

  upsert(ns: string, grantee: NamespaceGrantee, mode: NamespaceGrantMode): NamespaceGrant {
    const g = validateGrantee(grantee);
    const key = `${ns}\0${granteeKey(g)}`;
    const now = Date.now();
    const existingId = this.byNsGrantee.get(key);
    if (existingId) {
      const prev = this.byId.get(existingId);
      if (prev) {
        const next: NamespaceGrant = { ...prev, mode, updatedAt: now, grantee: g };
        this.byId.set(existingId, next);
        return { ...next, grantee: { ...next.grantee } };
      }
    }
    const id = nextGrantId();
    const grant: NamespaceGrant = {
      id,
      ns,
      grantee: g,
      mode,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(id, grant);
    this.byNsGrantee.set(key, id);
    return { ...grant, grantee: { ...grant.grantee } };
  }

  delete(id: string): boolean {
    const g = this.byId.get(id);
    if (!g) return false;
    this.byId.delete(id);
    this.byNsGrantee.delete(`${g.ns}\0${granteeKey(g.grantee)}`);
    return true;
  }

  /** True when `caller` may access `ns` at `mode` (own ns, or a matching grant). */
  allows(caller: SharingCaller, ns: string, mode: NamespaceGrantMode): boolean {
    return namespaceAccess(this, caller, ns, mode);
  }
}

/**
 * Own-namespace is always allowed. Cross-app requires a grant whose mode
 * covers the requested mode (`readwrite` covers `read`). Agent callers match
 * `{ type: "agent" }` grants; app callers match `{ type: "app", appId }`.
 */
export function namespaceAccess(
  store: MemoryGrantStore,
  caller: SharingCaller,
  ns: string,
  mode: NamespaceGrantMode,
): boolean {
  const own = (caller.appId || "").trim();
  if (own && ns === own) return true;
  for (const g of store.list(ns)) {
    if (!granteeMatches(g.grantee, caller)) continue;
    if (mode === "read" || g.mode === "readwrite") return true;
  }
  return false;
}

function granteeMatches(grantee: NamespaceGrantee, caller: SharingCaller): boolean {
  if (grantee.type === "agent") return caller.kind === "agent";
  return caller.kind === "app" && grantee.appId === caller.appId;
}

export function notGrantedError(
  subsystem: "storage" | "sync" | "fs",
  ns: string,
): ReturnType<typeof subsystemError> {
  return subsystemError(`${subsystem}_not_granted`, `no grant to access namespace "${ns}"`);
}

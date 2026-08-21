// Shared namespace/backend-resolution machinery for the app-namespaced
// resources (`sdk.storage`, `sdk.fs`). INTERNAL — not exported from any public
// barrel. Both facades resolve their backend the same way (an injected backend
// always wins → server-capable clients get a lazily-built, cached cloud
// backend → otherwise unavailable) and derive namespace handles the same way
// (own namespace read-write, cross-app defaults to read-only). The public
// mode types (`NamespaceMode`, `FsNamespaceMode`) stay defined in their own
// subsystems as literal unions; `KvNamespaceMode` is their structural twin.
import { subsystemError } from "../../core/errors";

/** Access mode for a namespace handle ("read" rejects writes). */
export type KvNamespaceMode = "read" | "readwrite";

/** The one thing the shared machinery needs to know about a backend. */
export interface AvailabilityBackend {
  available(): boolean;
}

/** The subsystems sharing this machinery; keys error codes and messages. */
export type NamespacedSubsystem = "storage" | "fs";

/**
 * The injected-wins → lazy-cloud → null backend resolution both facades use.
 * Thunks (not values) so each `resolve()` re-reads the client's current state,
 * exactly like the inlined originals; the cloud backend is built at most once.
 */
export class BackendResolver<B extends AvailabilityBackend> {
  private cloud: B | null = null;

  constructor(
    private readonly injected: () => B | null | undefined,
    private readonly serverCapable: () => boolean,
    private readonly createCloud: () => B,
  ) {}

  resolve(): B | null {
    // 1. An explicitly injected backend always wins (tests inject a double; a
    //    host could inject a custom one).
    const inj = this.injected();
    if (inj) return inj;
    // 2. Server-capable clients (a token is configured) use the cloud backend
    //    so data lives in Supabase (via unified-api) and follows the user.
    if (this.serverCapable()) {
      this.cloud ??= this.createCloud();
      return this.cloud;
    }
    // 3. No token and nothing injected: the resource is unavailable. There is
    //    deliberately no local browser fallback (Supabase-only).
    return null;
  }

  /** Whether a usable backend exists in the current runtime. */
  available(): boolean {
    const b = this.resolve();
    return !!b && b.available();
  }
}

/**
 * Derive the target namespace id + access mode for `namespace(appId?, opts)`:
 * the calling app's own namespace (from the client's `appId`, host-stamped per
 * app) unless a cross-app target is named; cross-app defaults to read-only.
 */
export function deriveNamespace(
  clientAppId: string | undefined,
  targetAppId: string | undefined,
  requestedMode: KvNamespaceMode | undefined,
): { id: string; mode: KvNamespaceMode } {
  const own = (clientAppId || "").trim() || "default";
  const id = targetAppId?.trim() || own;
  const crossApp = id !== own;
  return { id, mode: requestedMode ?? (crossApp ? "read" : "readwrite") };
}

/** Guard: the backend must exist and report available, else `<subsystem>_unavailable`. */
export function requireAvailableBackend<B extends AvailabilityBackend>(
  backend: B | null,
  subsystem: NamespacedSubsystem,
): B {
  if (!backend || !backend.available()) {
    throw subsystemError(
      `${subsystem}_unavailable`,
      `no ${subsystem} backend is available in this runtime`,
    );
  }
  return backend;
}

/** Guard: writes through a read-only namespace throw `<subsystem>_read_only`. */
export function assertWritableNamespace(
  mode: KvNamespaceMode,
  ns: string,
  subsystem: NamespacedSubsystem,
): void {
  if (mode === "read") {
    throw subsystemError(`${subsystem}_read_only`, `namespace "${ns}" is read-only`);
  }
}

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
export declare class BackendResolver<B extends AvailabilityBackend> {
    private readonly injected;
    private readonly serverCapable;
    private readonly createCloud;
    private cloud;
    constructor(injected: () => B | null | undefined, serverCapable: () => boolean, createCloud: () => B);
    resolve(): B | null;
    /** Whether a usable backend exists in the current runtime. */
    available(): boolean;
}
/**
 * Derive the target namespace id + access mode for `namespace(appId?, opts)`:
 * the calling app's own namespace (from the client's `appId`, host-stamped per
 * app) unless a cross-app target is named; cross-app defaults to read-only.
 */
export declare function deriveNamespace(clientAppId: string | undefined, targetAppId: string | undefined, requestedMode: KvNamespaceMode | undefined): {
    id: string;
    mode: KvNamespaceMode;
};
/** Guard: the backend must exist and report available, else `<subsystem>_unavailable`. */
export declare function requireAvailableBackend<B extends AvailabilityBackend>(backend: B | null, subsystem: NamespacedSubsystem): B;
/** Guard: writes through a read-only namespace throw `<subsystem>_read_only`. */
export declare function assertWritableNamespace(mode: KvNamespaceMode, ns: string, subsystem: NamespacedSubsystem): void;
//# sourceMappingURL=namespace.d.ts.map
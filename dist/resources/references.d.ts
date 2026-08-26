import type { Core } from "../core/core.js";
import type { TargetKind } from "./projects.js";
export interface ReferenceHandle {
    projectId: string;
    linkId: string;
}
/** A resolved reference — content plus the locator the app needs to render it. */
export interface ResolvedReference {
    linkId: string;
    projectId: string;
    targetApp: string;
    targetKind: TargetKind;
    /** App-interpreted portion locator; `{}` means the whole artifact. */
    fragment: Record<string, unknown>;
    artifactType: string;
    label: string | null;
    /** "portion" → snapshot bytes; "whole" → live artifact bytes. */
    kind: "portion" | "whole";
    /** False when a whole-artifact target was deleted out from under the link. */
    found: boolean;
    /** Portion only: the source has changed since the snapshot — offer a resync. */
    stale: boolean;
    /** Target's current updatedAt (whole) or the snapshot capture time (portion). */
    updatedAt: number | null;
    /** Whole-object metadata; null for portions and files. */
    metadata: Record<string, unknown> | null;
    /** Raw blob encoding, when present. */
    encoding: string | null;
    /** Decoded text when the blob is UTF-8; otherwise null (see `bytes`). */
    text: string | null;
    /** Raw bytes when the blob is binary; otherwise null (see `text`). */
    bytes: Uint8Array | null;
}
export interface ResolveOptions {
    signal?: AbortSignal;
}
export declare class References {
    private readonly client;
    constructor(client: Core);
    /** Build a `uniref://<projectId>/<linkId>` handle an app can embed inline. */
    static format(projectId: string, linkId: string): string;
    format(projectId: string, linkId: string): string;
    /** Parse a `uniref://` handle. Throws on a malformed URI. */
    static parse(uri: string): ReferenceHandle;
    parse(uri: string): ReferenceHandle;
    /**
     * Resolve a reference (a `uniref://` URI, a {@link ReferenceHandle}, or a bare
     * linkId) into content. For a portion the bytes are the captured snapshot;
     * inspect `stale` to know whether the live source has drifted.
     */
    resolve(ref: string | ReferenceHandle, options?: ResolveOptions): Promise<ResolvedReference>;
    /**
     * Re-snapshot a portion reference from fresh app-extracted bytes (the app
     * re-runs its own extraction against the live source). Clears `stale`.
     */
    resync(ref: string | ReferenceHandle, snapshot: {
        content: string | Uint8Array | ArrayBuffer;
        preview?: string;
    }): Promise<ResolvedReference>;
}
//# sourceMappingURL=references.d.ts.map
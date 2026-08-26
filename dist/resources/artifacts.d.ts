import type { Core } from "../core/core.js";
/** An optional rendered preview (server stores it; fetch a signed URL via `previewUrl`). */
export interface PreviewRef {
    bucket: string;
    path: string;
    mime: string;
}
export interface Artifact {
    id: string;
    projectId: string | null;
    /** Producing app — server-attributed. */
    appId: string;
    /** Open vocabulary, namespaced: "docs/document", "sheets/spreadsheet", … */
    kind: string;
    title: string;
    /** Current version pointer. */
    version: number;
    createdAt: number;
    updatedAt: number;
}
export interface ArtifactVersion {
    artifactId: string;
    version: number;
    /** Canonical machine-readable content; per-kind, self-contained JSON. */
    content: unknown;
    /** Required plain-text projection. */
    text: string;
    previewRef: PreviewRef | null;
    /** Client attribution — server-stamped. */
    contributedBy: string;
    createdAt: number;
}
export interface ArtifactWithVersion {
    artifact: Artifact;
    version: ArtifactVersion;
}
/** App-rendered preview bytes; a string is captured UTF-8. */
export interface PreviewInput {
    content: string | Uint8Array | ArrayBuffer;
    mime?: string;
}
export interface CreateArtifactInput {
    projectId?: string | null;
    kind: string;
    title: string;
    content: unknown;
    text: string;
    preview?: PreviewInput;
}
export interface AddVersionInput {
    content: unknown;
    text: string;
    preview?: PreviewInput;
}
export interface ListArtifactsOptions {
    projectId?: string;
    kind?: string;
    signal?: AbortSignal;
}
export declare class Artifacts {
    private readonly client;
    constructor(client: Core);
    /** Publish a new artifact (creates version 1). */
    create(input: CreateArtifactInput): Promise<ArtifactWithVersion>;
    /** List artifacts, optionally scoped by project and/or kind. */
    list(options?: ListArtifactsOptions): Promise<Artifact[]>;
    /** Fetch an artifact and its latest version. Throws `NotFoundError` if absent. */
    get(id: string): Promise<{
        artifact: Artifact;
        latest: ArtifactVersion | null;
    }>;
    /** Append a new version (whole snapshot) and bump the pointer. */
    addVersion(id: string, input: AddVersionInput): Promise<ArtifactWithVersion>;
    /** Fetch a specific version, or null if that version doesn't exist. */
    getVersion(id: string, version: number): Promise<ArtifactVersion | null>;
    /** A short-lived signed URL to a version's preview, or null when there is none. */
    previewUrl(id: string, version?: number): Promise<{
        url: string;
        mime: string;
    } | null>;
    /**
     * Resolve a chat/cross-app reference `artifact://<id>[@<version>]` to its artifact +
     * version. Returns null if the ref is malformed or the target is gone.
     */
    resolveRef(ref: string): Promise<ArtifactWithVersion | null>;
}
//# sourceMappingURL=artifacts.d.ts.map